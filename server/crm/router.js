'use strict';
// Minimal method + path router with :params.

class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, opts = {}) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-z_]+)/g, (_, n) => { names.push(n); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, names, handler, opts: { auth: true, ...opts } });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Returns {route, params} | {methodNotAllowed: true} | null */
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.names.forEach((n, i) => {
        try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = ''; }
      });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router };
