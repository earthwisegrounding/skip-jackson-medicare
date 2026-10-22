'use strict';
// Byte-range support for media files (Safari needs it to play the home-page audio message).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request } = require('./helpers');
const { parseRange } = require('../server/static');

test('parseRange', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=9-3', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null); // multi-range: whole file
  assert.equal(parseRange('items=0-1', 100), null);
});

test('audio files are served with byte ranges', async (t) => {
  const s = await startServer();
  const pub = fs.mkdtempSync(path.join(s.dataDir, 'pub-'));
  const bytes = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256));
  fs.mkdirSync(path.join(pub, 'media'));
  fs.writeFileSync(path.join(pub, 'media', 'clip.mp3'), bytes);
  fs.writeFileSync(path.join(pub, '404.html'), '<!doctype html><title>Missing</title>');
  const s2 = await startServer({ publicDir: pub });
  t.after(async () => { await s2.close(); await s.close(); });

  let r = await request(s2.base, 'GET', '/media/clip.mp3');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');

  const res = await fetch(s2.base + '/media/clip.mp3', { headers: { range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/2000');
  assert.equal(res.headers.get('content-length'), '100');
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, bytes.subarray(100, 200));

  r = await request(s2.base, 'GET', '/media/clip.mp3', { headers: { range: 'bytes=5000-' } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */2000');

  // Text assets are never range-served (they may be gzipped).
  fs.writeFileSync(path.join(pub, 'a.css'), 'body{}'.repeat(400));
  r = await request(s2.base, 'GET', '/a.css', { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 200);
});
