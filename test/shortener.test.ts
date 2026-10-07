import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  BASE62,
  CODE_LENGTH,
  CODE_SPACE,
  toBase62,
  randomCode,
  makeRng,
  createLab,
  simulateReads,
  LATENCY,
} from '../app/shortener.ts';
import { createStaticServer } from '../app/server.ts';

test('toBase62 encodes counters into the base62 alphabet at fixed length', () => {
  assert.equal(toBase62(0).length, CODE_LENGTH);
  assert.equal(toBase62(1), '0000001');
  assert.equal(toBase62(62), '0000010');
  assert.ok([...toBase62(123456789)].every(c => BASE62.includes(c)));
  assert.throws(() => toBase62(-1), RangeError);
});

test('the 7-char base62 space is ~3.5 trillion codes', () => {
  assert.equal(CODE_SPACE, Math.pow(62, 7));
  assert.ok(CODE_SPACE > 3.5e12);
});

test('counter strategy mints unique codes with ZERO collision lookups', () => {
  const lab = createLab({ seed: 1 });
  const codes = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const r = lab.shorten(`https://example.com/${i}`, { strategy: 'counter' });
    codes.add(r.code);
    assert.equal(r.collisionLookups, 0);
  }
  assert.equal(codes.size, 500, 'counter codes must be unique by construction');
  assert.equal(lab.stats().collisionLookups, 0);
});

test('random strategy checks the store on every draw — and rigged collisions retry', () => {
  const lab = createLab({ seed: 11 });
  lab.shorten('https://example.com/seed', { strategy: 'counter' });
  lab.rig(3); // force the next 3 draws to collide — failure mode on demand
  const r = lab.shorten('https://example.com/rigged', { strategy: 'random' });
  assert.ok(r.attempts > 1, 'rigged draws must collide at least once');
  assert.equal(r.collisionLookups, r.attempts);
  assert.ok(lab.stats().collisionLookups >= r.attempts);
  // every lookup is a DB read the counter strategy never pays
  assert.ok(lab.stats().dbReads >= r.attempts);
});

test('random generation is deterministic for a given seed', () => {
  const a = randomCode(makeRng(99));
  const b = randomCode(makeRng(99));
  assert.equal(a, b);
});

test('read path: write-through makes the first resolve a cache hit', () => {
  const lab = createLab();
  const { code } = lab.shorten('https://example.com/hot');
  const r = lab.resolve(code, { status: 302, analytics: 'queued' });
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://example.com/hot');
  assert.equal(r.servedBy, 'edge-cache');
  assert.equal(lab.stats().cacheHits, 1);
  assert.equal(lab.stats().dbReads, 0, 'no DB read on a cache hit');
});

test('inline analytics puts a DB write on the read path; queued does not', () => {
  const lab = createLab();
  const { code } = lab.shorten('https://example.com/x');
  const inline = lab.resolve(code, { analytics: 'inline' });
  const queued = lab.resolve(code, { analytics: 'queued' });
  assert.equal(inline.latencyMs - queued.latencyMs, LATENCY.dbWrite);
  assert.ok(inline.steps.some(s => s.component === 'analytics-db'));
  assert.ok(queued.steps.some(s => s.component === 'queue'));
  assert.equal(inline.clickCounted, true);
  assert.equal(queued.clickCounted, true);
});

test('skewed traffic stays cached: 100 reads at 90% hot share are >90% hits', () => {
  const lab = createLab();
  const codes = [];
  for (let i = 0; i < 20; i++) codes.push(lab.shorten(`https://e.com/${i}`).code);
  // unknown codes take the miss path: cache check, DB read, 404, no populate
  const miss = lab.resolve('never-issued', {});
  assert.equal(miss.status, 404);
  assert.equal(miss.servedBy, 'none');
  assert.equal(lab.stats().cacheMisses, 1);
  const { hitRate } = simulateReads(lab, codes, 100, { hotShare: 0.9 });
  assert.ok(hitRate >= 0.9, `hit rate ${hitRate} should be >= 0.9`);
});

test('301 is a one-way door: repeat clicks never reach the server', () => {
  const lab = createLab();
  const { code } = lab.shorten('https://example.com/promo');
  const results = [];
  for (let i = 0; i < 10; i++) results.push(lab.resolve(code, { status: 301, analytics: 'queued' }));
  const s = lab.stats();
  assert.equal(s.clicksCounted, 1, 'only the first 301 click is ever seen');
  assert.equal(s.browserCacheHits, 9, 'the other 9 resolve inside the browser');
  assert.equal(results[1].servedBy, 'browser-cache');
  assert.equal(results[1].clickCounted, false);
});

test('302 re-asks every time: every repeat click is counted', () => {
  const lab = createLab();
  const { code } = lab.shorten('https://example.com/promo');
  for (let i = 0; i < 10; i++) lab.resolve(code, { status: 302, analytics: 'queued' });
  const s = lab.stats();
  assert.equal(s.clicksCounted, 10);
  assert.equal(s.browserCacheHits, 0);
});

test('queued analytics still counts every visible click', () => {
  const lab = createLab();
  const { code } = lab.shorten('https://example.com/promo');
  for (let i = 0; i < 5; i++) lab.resolve(code, { status: 302, analytics: 'queued' });
  assert.equal(lab.stats().queuedEvents, 5);
  assert.equal(lab.stats().clicksCounted, 5);
});

// --- HTTP level: the same model served over real HTTP ------------------------

async function listen() {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('/health, /version, static assets, and 404', async () => {
  const server = await listen();
  const port = (server.address() as { port: number }).port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`http://127.0.0.1:${port}/version`);
    assert.equal(version.status, 200);
    const meta = await version.json();
    assert.equal(meta.name, 'url-shortener-design-demo');

    for (const path of ['/', '/tokens.css', '/app/app.js', '/app/shortener.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, path);
    }

    // the browser gets real JS: type annotations must be stripped
    const model = await fetch(`http://127.0.0.1:${port}/app/shortener.js`);
    const src = await model.text();
    assert.ok(src.includes('export function createLab'));
    assert.ok(!src.includes('interface LabStats'), 'TS interfaces must be stripped');
    assert.ok(!src.includes(': number'), 'type annotations must be stripped');

    for (const path of ['/package.json', '/nope', '/app/shortener.ts']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    server.close();
  }
});

test('POST /api/shorten then GET /r/:code issues a real 302 and counts the click', async () => {
  const server = await listen();
  const port = (server.address() as { port: number }).port;
  try {
    await fetch(`http://127.0.0.1:${port}/api/reset`, { method: 'POST' });
    const created = await fetch(`http://127.0.0.1:${port}/api/shorten`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/landing', strategy: 'counter' }),
    });
    assert.equal(created.status, 200);
    const link = await created.json();
    assert.equal(link.collisionLookups, 0);

    const redirect = await fetch(`http://127.0.0.1:${port}/r/${link.code}?status=302`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://example.com/landing');

    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    assert.equal(stats.stats.clicksCounted, 1, 'the 302 click was counted via the queued event');
    assert.equal(stats.stats.redirectsServed, 1);

    const unknown = await fetch(`http://127.0.0.1:${port}/r/zzzzzzz`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);
  } finally {
    server.close();
  }
});
