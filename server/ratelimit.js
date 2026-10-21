'use strict';
// In-memory sliding-window rate limiter with bounded memory.

const net = require('node:net');

/** Normalise an IP for rate limiting: IPv4 as-is, IPv4-mapped IPv6 -> IPv4, other IPv6 -> its /64 prefix. */
function ipKey(ip) {
  const s = String(ip || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  if (net.isIPv6(s)) {
    let [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    if (t.length && t[t.length - 1].includes('.')) t.pop(); // embedded IPv4 tail: not needed for /64
    const fill = s.includes('::') ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
    const groups = [...h, ...fill, ...t].map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''));
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return s;
}

class RateLimiter {
  /** rules: [{windowMs, max}], maxKeys bounds memory (oldest keys are evicted first). */
  constructor(rules, { maxKeys = 50000, keyFn = (k) => k } = {}) {
    this.rules = rules;
    this.maxKeys = maxKeys;
    this.keyFn = keyFn;
    this.hits = new Map();
    this.maxWindow = Math.max(...rules.map((r) => r.windowMs));
  }

  /** Record a hit; returns false when over a limit (the hit is not recorded then). */
  hit(rawKey, now = Date.now()) {
    const key = this.keyFn(rawKey);
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.maxWindow);
    for (const r of this.rules) {
      if (list.filter((t) => now - t < r.windowMs).length >= r.max) { this.touch(key, list); return false; }
    }
    list.push(now);
    this.touch(key, list);
    return true;
  }

  /** True when the next hit would be over a limit (does not record anything). */
  blocked(rawKey, now = Date.now()) {
    const list = this.hits.get(this.keyFn(rawKey));
    if (!list) return false;
    return this.rules.some((r) => list.filter((t) => now - t < r.windowMs).length >= r.max);
  }

  touch(key, list) {
    this.hits.delete(key); // re-insert so Map order = least recently used first
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
  }

  prune(now = Date.now()) {
    for (const [k, list] of this.hits) {
      const kept = list.filter((t) => now - t < this.maxWindow);
      if (kept.length) this.hits.set(k, kept); else this.hits.delete(k);
    }
  }

  get size() { return this.hits.size; }
}

module.exports = { RateLimiter, ipKey };
