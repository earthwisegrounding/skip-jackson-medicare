'use strict';
// /crm/api/* dispatcher: session loading, CSRF + origin checks, RBAC, JSON I/O.

const { Router } = require('./router');
const { HttpError, sendJson, readJson, parseCookies, mediaType, clientIp, isHttps, originAllowed } = require('../http');
const A = require('../auth');
const { RateLimiter, ipKey } = require('../ratelimit');
const { registerAccountRoutes } = require('./account');
const { registerRecordRoutes } = require('./records');
const { registerOverviewRoutes } = require('./overview');
const { registerEventRoutes } = require('./events');

const JSON_LIMIT = 100 * 1024;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function createCrmApi(ctx) {
  const { db, cfg, log } = ctx;
  const router = new Router();
  ctx.loginLimiter = new RateLimiter([{ windowMs: 15 * 60 * 1000, max: cfg.loginLimit }], { keyFn: ipKey, maxKeys: cfg.rateLimitMaxKeys });
  ctx.loginEmailLimiter = new RateLimiter([{ windowMs: 15 * 60 * 1000, max: cfg.loginEmailLimit }], { maxKeys: cfg.rateLimitMaxKeys });
  ctx.timers.push(setInterval(() => {
    ctx.loginLimiter.prune();
    ctx.loginEmailLimiter.prune();
    A.purgeExpiredSessions(db, cfg.sessionIdleMs);
  }, 5 * 60 * 1000).unref());

  registerAccountRoutes(router, ctx);
  registerRecordRoutes(router, ctx);
  registerOverviewRoutes(router, ctx);
  registerEventRoutes(router, ctx);

  return async function handleCrmApi(req, res, pathname, query) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Pragma', 'no-cache');
    const sub = pathname.slice('/crm/api'.length) || '/';
    const m = router.match(req.method, sub);
    if (!m) { sendJson(res, 404, { error: 'not_found' }); return; }
    if (m.methodNotAllowed) { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
    const { route, params } = m;

    const ip = clientIp(req, cfg);
    const cookies = parseCookies(req);
    const sess = cookies.crm_sid ? A.loadSession(db, cookies.crm_sid, { idleMs: cfg.sessionIdleMs, touch: sub !== '/session' }) : null;
    const session = sess && !sess.expired ? sess : null;
    const secure = cfg.cookieSecure || isHttps(req, cfg);
    const clearCookie = A.cookieHeader('crm_sid', '', { secure, maxAgeSec: 0 });

    if (session) req.crmUserId = session.user.id;
    const r = {
      req, res, params, query, ip, session, user: session ? session.user : null, secure,
      userAgent: String(req.headers['user-agent'] || ''), cookies, sessionExpired: Boolean(sess && sess.expired), body: {},
    };

    try {
      if (route.opts.auth && !session) {
        throw new HttpError(401, sess && sess.expired ? 'session_expired' : 'unauthenticated', sess ? { headers: { 'Set-Cookie': clearCookie } } : undefined);
      }
      if (STATE_CHANGING.has(req.method)) {
        if (!originAllowed(req, cfg)) throw new HttpError(403, 'bad_origin');
        if (route.opts.auth && !A.safeEqual(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, 'csrf');
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
        if (hasBody || mediaType(req)) r.body = await readJson(req, JSON_LIMIT);
      }
      if (route.opts.role && r.user.role !== route.opts.role) throw new HttpError(403, 'forbidden');

      const result = await route.handler(r);
      if (res.writableEnded || res.headersSent) return;
      sendJson(res, result && result.__status ? result.__status : 200, result && result.__status ? result.body : (result ?? { ok: true }));
    } catch (err) {
      if (err instanceof HttpError) {
        const extra = err.extra || {};
        const headers = extra.headers || {};
        const body = { error: err.code };
        for (const [k, v] of Object.entries(extra)) if (k !== 'headers') body[k] = v;
        if (!res.headersSent) sendJson(res, err.status, body, headers);
        return;
      }
      log.error('crm_api_error', { path: sub, method: req.method, err: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
  };
}

module.exports = { createCrmApi, originAllowed, JSON_LIMIT };
