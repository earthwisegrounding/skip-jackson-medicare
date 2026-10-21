'use strict';
// HTTP plumbing: security headers, body parsing, cookies, responses.

const net = require('node:net');

const CSP_CRM = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'",
].join('; ');

const CSP_PUBLIC = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com', "img-src 'self' data: https://i.ytimg.com", "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com', "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'self'", "base-uri 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function isHttps(req, cfg) {
  if (req.socket && req.socket.encrypted) return true;
  if (cfg.trustProxy) return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return false;
}

/**
 * The client's IP address.
 * - Without TRUST_PROXY, always the socket address (headers are ignored: anyone can send them).
 * - With TRUSTED_CLIENT_IP_HEADER (e.g. Fly-Client-IP, CF-Connecting-IP), that single header, if it's a valid IP.
 * - Otherwise X-Forwarded-For read from the RIGHT: each trusted proxy appends the address it saw, so the
 *   client is the entry TRUST_PROXY_HOPS positions from the end. Left-most entries are client-controlled.
 */
function clientIp(req, cfg) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!cfg.trustProxy) return socketIp;
  if (cfg.trustedClientIpHeader) {
    const v = String(req.headers[cfg.trustedClientIpHeader.toLowerCase()] || '').trim();
    return net.isIP(v) ? v : socketIp;
  }
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const hops = Math.max(1, cfg.proxyHops || 1);
  const candidate = parts[parts.length - hops];
  return candidate && net.isIP(candidate) ? candidate : socketIp;
}

/** Reject cross-site browser requests (Origin / Sec-Fetch-Site). Requests without either header pass. */
function originAllowed(req, cfg) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    const expected = (cfg.trustProxy && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host;
    if (!expected || host !== expected) return false;
  }
  return true;
}

function securityHeaders(req, res, cfg, isCrm) {
  res.setHeader('Content-Security-Policy', isCrm ? CSP_CRM : CSP_PUBLIC);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isHttps(req, cfg)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (isCrm) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : text);
}

function redirect(res, status, location) {
  res.writeHead(status, { Location: location, 'Content-Length': 0 });
  res.end();
}

/** Read the request body up to `limit` bytes. Throws HttpError(413) when exceeded. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'too_large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(new HttpError(413, 'too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function mediaType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

async function readJson(req, limit) {
  const type = mediaType(req);
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

module.exports = {
  CSP_CRM, CSP_PUBLIC, HttpError, isHttps, clientIp, originAllowed, securityHeaders, sendJson, sendText, redirect,
  readBody, readJson, parseForm, parseCookies, mediaType,
};
