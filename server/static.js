'use strict';
// Safe static file serving for the public site and the CRM shell.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.txt', '.xml', '.svg', '.webmanifest']);

/**
 * Resolve a URL pathname to a file inside `root`. Returns
 * {file, stat} | {redirect} | null (not found / forbidden).
 */
function resolve(root, urlPath, prefix = '') {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
    if (seg.startsWith('.') && seg !== '.well-known') return null; // no dotfiles
  }
  const rootReal = fs.realpathSync(root);
  let target = path.join(rootReal, ...segments);
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) return null;
  let stat;
  try { stat = fs.statSync(target); } catch { return null; }
  if (stat.isDirectory()) {
    // Build the Location from normalized, encoded segments (never echo the raw path: "//evil.example/" would be an open redirect).
    if (!urlPath.endsWith('/')) return { redirect: `${prefix}/${segments.map(encodeURIComponent).join('/')}/` };
    target = path.join(target, 'index.html');
    try { stat = fs.statSync(target); } catch { return null; }
  }
  if (!stat.isFile()) return null;
  // Defeat symlinks that point outside the root.
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  if (!real.startsWith(rootReal + path.sep)) return null;
  return { file: real, stat };
}

function cacheControl(ext, { noCache = false } = {}) {
  if (noCache || ext === '.html' || ext === '.webmanifest' || ext === '.xml' || ext === '.txt') return 'no-cache';
  if (ext === '.css' || ext === '.js' || ext === '.mjs') return 'public, max-age=3600';
  return 'public, max-age=86400';
}

/** Stream a resolved file. Handles HEAD, ETag/Last-Modified and gzip. */
function sendFile(req, res, file, stat, { status = 200, noCache = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cacheControl(ext, { noCache }));
  if (status === 200) {
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if ((inm && inm === etag) || (!inm && ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
      res.writeHead(304);
      res.end();
      return;
    }
  }
  const gzip = COMPRESSIBLE.has(ext) && stat.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (COMPRESSIBLE.has(ext)) res.setHeader('Vary', 'Accept-Encoding');
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  else res.setHeader('Content-Length', stat.size);
  res.writeHead(status);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  if (gzip) stream.pipe(zlib.createGzip()).pipe(res);
  else stream.pipe(res);
}

function serveStatic(req, res, root, urlPath, { notFound, noCache = false, prefix = '' } = {}) {
  const r = resolve(root, urlPath, prefix);
  if (r && r.redirect) {
    res.writeHead(301, { Location: r.redirect, 'Content-Length': 0 });
    res.end();
    return;
  }
  if (r) { sendFile(req, res, r.file, r.stat, { noCache }); return; }
  notFound();
}

module.exports = { resolve, sendFile, serveStatic, TYPES };
