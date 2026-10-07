// Shortener Lab — DOM wiring.
// JavaScript exception (documented): browsers cannot strip TypeScript types
// and this project forbids a build step, so the UI glue is plain .js. The
// domain logic is NOT duplicated — it imports /app/shortener.js, which the
// server generates by type-stripping the same app/shortener.ts the tests run.
import { createLab, simulateReads, CODE_SPACE } from '/app/shortener.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The in-page lab for sections 1–3. Sections 4–5 use their own instances.
const lab = createLab({ seed: 7 });
const state = { strategy: 'counter' };

function stepsHtml(steps) {
  const max = Math.max(...steps.map(s => s.latencyMs), 1);
  return '<div class="steps">' + steps.map(s => `
    <div class="step ${s.latencyMs >= 8 ? 'hot' : ''}">
      <span class="comp">${esc(s.component)}</span>
      <span class="act">${esc(s.action)}
        <span class="bar"><span class="bar fill ${s.latencyMs >= 8 ? 'bad' : ''}" style="width:${Math.max(3, Math.round(s.latencyMs / max * 100))}%"></span></span>
      </span>
      <span class="ms">${s.latencyMs} ms</span>
    </div>`).join('') + '</div>';
}

function setToggle(btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
}

function ensureLinks() {
  if (lab.links().length === 0) {
    for (let i = 1; i <= 60; i++) {
      lab.shorten(`https://example.com/campaign/${i}`, { strategy: 'counter' });
    }
  }
  return lab.links();
}

function refreshCodeStats() {
  const s = lab.stats();
  $('stCodes').textContent = s.codesIssued;
  $('stLookups').textContent = s.collisionLookups;
}

// --- Section 1: mint the code ----------------------------------------------

$('btnCounter').addEventListener('click', () => {
  state.strategy = 'counter';
  setToggle($('btnCounter'), true);
  setToggle($('btnRandom'), false);
});
$('btnRandom').addEventListener('click', () => {
  state.strategy = 'random';
  setToggle($('btnCounter'), false);
  setToggle($('btnRandom'), true);
});

$('btnShorten').addEventListener('click', () => {
  const rigged = $('rigChk').checked && state.strategy === 'random';
  if (rigged) lab.rig(24); // force the next draws to collide — failure on demand
  let last = null;
  for (let i = 0; i < 200; i++) {
    last = lab.shorten(`https://example.com/item/${lab.stats().codesIssued + 1}`, { strategy: state.strategy });
  }
  refreshCodeStats();
  const headline = state.strategy === 'counter'
    ? `<strong>Last code:</strong> <code>${esc(last.code)}</code> — counter value encoded in base62. ${last.collisionLookups} collision lookups.`
    : `<strong>Last code:</strong> <code>${esc(last.code)}</code> — took ${last.attempts} attempt(s) and ${last.collisionLookups} DB read(s) before the write.`;
  $('codeTrace').innerHTML = `<h3>Write path of the last insert</h3><p>${headline}</p>${stepsHtml(last.steps)}`;
  const links = lab.links().slice(-24);
  $('codeList').innerHTML = links.map(l => `<span>${esc(l.code)}</span>`).join('');
});

// --- Section 2: the read path ------------------------------------------------

$('btnReads').addEventListener('click', () => {
  const codes = ensureLinks().map(l => l.code);
  const before = lab.stats();
  const { results } = simulateReads(lab, codes, 100, { hotShare: 0.9 });
  const after = lab.stats();
  const hits = after.cacheHits - before.cacheHits;
  const misses = after.cacheMisses - before.cacheMisses;
  const rate = hits + misses === 0 ? 0 : Math.round(hits / (hits + misses) * 100);
  $('stHitRate').textContent = rate + '%';
  $('stCacheHits').textContent = hits;
  $('stCacheMiss').textContent = misses;
  const rep = results.find(r => r.servedBy === 'edge-cache') || results[0];
  $('readTrace').innerHTML = `<h3>A cache-hit redirect — the whole read path</h3>${stepsHtml(rep.steps)}`;
});

// --- Section 3: analytics placement -----------------------------------------

$('btnAnalytics').addEventListener('click', () => {
  const codes = ensureLinks().map(l => l.code);
  const inline = simulateReads(lab, codes, 100, { analytics: 'inline' });
  const queued = simulateReads(lab, codes, 100, { analytics: 'queued' });
  const li = Math.round(inline.avgLatencyMs * 10) / 10;
  const lq = Math.round(queued.avgLatencyMs * 10) / 10;
  $('latInline').textContent = li + ' ms';
  $('latQueued').textContent = lq + ' ms';
  $('barInline').style.width = '100%';
  $('barQueued').style.width = Math.max(3, Math.round(lq / li * 100)) + '%';
  $('noteInline').textContent = `Every redirect paid a DB write first — ${li - lq} ms of pure analytics tax per click.`;
  $('noteQueued').textContent = 'Same clicks, same counts — the event reaches the queue; the redirect never waits on it.';
});

// --- Section 4: 301 vs 302 ----------------------------------------------------

$('btnStatusRun').addEventListener('click', () => {
  const run = status => {
    const l = createLab({ seed: 3 });
    const { code } = l.shorten('https://example.com/promo');
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(l.resolve(code, { status, analytics: 'queued' }));
    }
    const s = l.stats();
    return { results, counted: s.clicksCounted, lost: s.browserCacheHits };
  };
  const r301 = run(301);
  const r302 = run(302);
  $('sent301').textContent = r301.results.length;
  $('counted301').textContent = r301.counted;
  $('lost301').textContent = r301.lost;
  $('sent302').textContent = r302.results.length;
  $('counted302').textContent = r302.counted;
  $('lost302').textContent = r302.lost;
  // Show the SECOND click — the one the browser swallows for 301.
  $('steps301').innerHTML = `<h3>Click #2 — resolved inside the browser</h3>${stepsHtml(r301.results[1].steps)}`;
  $('steps302').innerHTML = `<h3>Click #2 — a normal server read path</h3>${stepsHtml(r302.results[1].steps)}`;
  $('statusNote').textContent = r301.lost > 0
    ? `${r301.lost} of ${r301.results.length} clicks never reached the server. The analytics pipeline is not broken — the requests simply never arrive. That is the week you lose debugging it.`
    : '';
});

// --- Section 5: over real HTTP --------------------------------------------------

async function refreshLiveStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    $('liveCodes').textContent = data.stats.codesIssued;
    $('liveClicks').textContent = data.stats.clicksCounted;
    $('liveRedirects').textContent = data.stats.redirectsServed;
  } catch { /* server unreachable — leave stale numbers */ }
}

$('btnLiveShorten').addEventListener('click', async () => {
  const url = $('urlInput').value.trim();
  const strategy = $('liveStrategy').value;
  const status = $('liveStatus').value;
  const res = await fetch('/api/shorten', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, strategy }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('liveOut').innerHTML = `<p class="note bad">${esc(data.error || 'request failed')}</p>`;
    return;
  }
  const href = `/r/${encodeURIComponent(data.code)}?status=${status}`;
  $('liveOut').innerHTML = `
    <p><strong>Your short link:</strong> <a href="${href}" target="_blank" rel="noopener"><code>${esc(href)}</code></a>
       — opens in a new tab with a real <code>${status}</code> redirect.</p>
    ${stepsHtml(data.steps)}
    <p class="note">Opened it? Watch <em>server clicks counted</em> below. Try <code>?status=301</code> twice in the same browser.</p>`;
  refreshLiveStats();
});

$('btnLiveReset').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  $('liveOut').innerHTML = '<p class="note">Server lab reset — shorten a new URL.</p>';
  refreshLiveStats();
});

// --- init -----------------------------------------------------------------------

$('stSpace').textContent = (CODE_SPACE / 1e12).toFixed(1) + 'T';
refreshCodeStats();
refreshLiveStats();
setInterval(refreshLiveStats, 3000);
