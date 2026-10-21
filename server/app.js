'use strict';
// Builds the single HTTP server: public site, lead intake, CRM UI and CRM API.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { securityHeaders, sendJson, sendText, redirect } = require('./http');
const { serveStatic, resolve, sendFile } = require('./static');
const { createLeadHandler } = require('./leads');
const { createCrmApi } = require('./crm/api');
const { createFormTokens } = require('./formtoken');
const A = require('./auth');

const ROOT = path.join(__dirname, '..');

function loadConfig(overrides = {}) {
  const env = process.env;
  const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    port: num(env.PORT, 8790),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    publicDir: path.join(ROOT, 'public'),
    crmDir: path.join(ROOT, 'crm'),
    trustProxy: env.TRUST_PROXY === '1',
    proxyHops: num(env.TRUST_PROXY_HOPS, 1),
    trustedClientIpHeader: env.TRUSTED_CLIENT_IP_HEADER || null,
    rateLimitMaxKeys: num(env.RATE_LIMIT_MAX_KEYS, 50000),
    loginEmailLimit: num(env.LOGIN_EMAIL_LIMIT_15MIN, 20),
    cookieSecure: env.COOKIE_SECURE === '1',
    sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 30) * 60 * 1000,
    sessionAbsoluteMs: num(env.SESSION_ABSOLUTE_HOURS, 12) * 3600 * 1000,
    leadLimitShort: num(env.LEAD_LIMIT_10MIN, 5),
    leadLimitDaily: num(env.LEAD_LIMIT_DAILY, 20),
    leadFailLimit: num(env.LEAD_FAIL_LIMIT_10MIN, 20),
    loginLimit: num(env.LOGIN_LIMIT_15MIN, 30),
    quiet: env.LOG_QUIET === '1',
    ...overrides,
  };
}

function makeLogger(quiet, sink) {
  const write = (level, msg, fields) => {
    if (quiet && level !== 'error') return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    if (sink) sink(line);
    else (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };
  return { info: (m, f) => write('info', m, f), error: (m, f) => write('error', m, f) };
}

function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const log = makeLogger(cfg.quiet, cfg.logSink);
  const db = openDb(cfg.dataDir);
  const ctx = { db, cfg, log, timers: [], formTokens: createFormTokens(cfg.dataDir) };
  A.warmDummyHash();
  const handleLead = createLeadHandler(ctx);
  const handleCrmApi = createCrmApi(ctx);
  const notFoundPage = path.join(cfg.publicDir, '404.html');

  function notFound(req, res) {
    if (fs.existsSync(notFoundPage)) {
      const r = resolve(cfg.publicDir, '/404.html');
      if (r && r.file) { sendFile(req, res, r.file, r.stat, { status: 404, noCache: true }); return; }
    }
    sendText(res, 404, '<!doctype html><meta charset="utf-8"><title>Page not found</title><h1>Page not found</h1><p><a href="/">Go to the home page</a></p>', 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    let pathname = '/';
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path only: never query strings or bodies (they can contain personal information).
      log.info('req', { m: req.method, p: pathname.slice(0, 200), s: res.statusCode, ms: Math.round(ms * 10) / 10, ...(req.crmUserId ? { u: req.crmUserId } : {}) });
    });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    const isCrm = pathname === '/crm' || pathname.startsWith('/crm/');
    securityHeaders(req, res, cfg, isCrm);

    try {
      if (pathname.startsWith('/api/')) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (pathname === '/api/form-token') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' }); return; }
        sendJson(res, 200, ctx.formTokens.issue(), { 'Cache-Control': 'no-store' });
        return;
      }
      if (pathname === '/api/leads') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return; }
        await handleLead(req, res);
        return;
      }
      if (pathname.startsWith('/api/')) { sendJson(res, 404, { ok: false, error: 'not_found' }); return; }
      if (pathname === '/crm/api' || pathname.startsWith('/crm/api/')) { await handleCrmApi(req, res, pathname, url.searchParams); return; }

      if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' }); return; }
      if (pathname === '/healthz') { sendJson(res, 200, { ok: true }, { 'Cache-Control': 'no-store' }); return; }
      if (pathname === '/crm') { redirect(res, 301, '/crm/'); return; }
      if (isCrm) {
        const sub = pathname.slice('/crm'.length);
        serveStatic(req, res, cfg.crmDir, sub, {
          noCache: true, prefix: '/crm',
          notFound: () => sendText(res, 404, 'Not found', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' }),
        });
        return;
      }
      serveStatic(req, res, cfg.publicDir, pathname, { notFound: () => notFound(req, res) });
    } catch (err) {
      log.error('unhandled', { p: pathname, err: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'server_error' });
      else res.destroy();
    }
  }

  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 15000 }, (req, res) => { handle(req, res); });
  server.keepAliveTimeout = 5000;

  function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolveListen(server.address()); });
    });
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const t of ctx.timers) clearInterval(t);
    await new Promise((r) => {
      server.close(() => r());
      server.closeIdleConnections();
      setTimeout(() => { server.closeAllConnections(); }, 8000).unref();
    });
    try { db.close(); } catch { /* already closed */ }
  }

  return { server, db, cfg, ctx, listen, close, log };
}

module.exports = { createApp, loadConfig };
