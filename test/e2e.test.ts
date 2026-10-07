// End-to-end: boot the real server on an ephemeral port and drive it with
// fetch() — pages, health/version, one API round trip, and the type-stripped
// modules the browser imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStaticServer } from '../app/server.ts';

async function withServer(fn: (base: string) => Promise<void>) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('GET / serves the Lab page with nav and the ids the JS drives', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<nav aria-label="Primary">/);
    assert.match(html, /<a aria-current="page" href="\/">Lab<\/a>/);
    assert.match(html, /href="\/guide\.html"/);
    assert.match(html, /github\.com\/anhquanbd2021\/url-shortener-design/);
    assert.match(html, /class="skip-link"/);
    assert.match(html, /class="hero"/);
    for (const id of [
      'btnCounter', 'btnRandom', 'rigChk', 'btnShorten',
      'stCodes', 'stLookups', 'stSpace', 'codeTrace', 'codeList',
      'btnReads', 'stHitRate', 'stCacheHits', 'stCacheMiss', 'readTrace',
      'btnAnalytics', 'latInline', 'latQueued', 'barInline', 'barQueued',
      'noteInline', 'noteQueued',
      'btnStatusRun', 'sent301', 'counted301', 'lost301', 'steps301',
      'sent302', 'counted302', 'lost302', 'steps302', 'statusNote',
      'urlInput', 'liveStrategy', 'liveStatus', 'btnLiveShorten',
      'btnLiveReset', 'liveOut', 'liveCodes', 'liveClicks', 'liveRedirects',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
    }
  });
});

test('GET /guide.html serves the Guide page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/guide.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<a aria-current="page" href="\/guide\.html">Guide<\/a>/);
    assert.match(html, /class="guide-section"/);
    assert.match(html, /class="control-grid"/);
    assert.match(html, /panel control/);
    assert.match(html, /<dt>Proves<\/dt>/);
    assert.match(html, /<dt>Key detail<\/dt>/);
  });
});

test('GET /health returns ok and /version returns JSON metadata', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    assert.match(version.headers.get('content-type') ?? '', /application\/json/);
    const meta = await version.json();
    assert.equal(meta.name, 'url-shortener-design-demo');
    assert.ok(meta.commit);
  });
});

test('POST /api/shorten then GET /r/:code issues a real redirect', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/reset`, { method: 'POST' });
    const created = await fetch(`${base}/api/shorten`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/e2e', strategy: 'counter' }),
    });
    assert.equal(created.status, 200);
    const link = await created.json();
    assert.match(link.code, /^[0-9a-zA-Z]{7}$/);

    const redirect = await fetch(`${base}/r/${link.code}?status=302`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://example.com/e2e');
  });
});

test('/app/*.js serves JavaScript with TypeScript types stripped', async () => {
  await withServer(async (base) => {
    for (const path of ['/app/app.js', '/app/shortener.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /javascript/);
      const body = await res.text();
      assert.ok(!body.includes('interface '), `${path} still contains TS interfaces`);
    }
    const model = await (await fetch(`${base}/app/shortener.js`)).text();
    assert.ok(model.includes('export function createLab'));
  });
});

test('stylesheets and theme assets are served', async () => {
  await withServer(async (base) => {
    for (const path of ['/tokens.css', '/styles.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    }
  });
});
