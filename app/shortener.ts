// Shortener Lab — the domain model.
// Single source of truth shared by the HTTP server, the browser UI (served
// type-stripped at /app/shortener.js), and the node:test suite.
// Erasable-syntax-only TypeScript: annotations, interfaces, type aliases.

// --- Short codes -------------------------------------------------------------

export const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const CODE_LENGTH = 7;
// 62^7 = 3,521,614,606,208 — ~3.5 trillion possible codes.
export const CODE_SPACE = Math.pow(62, CODE_LENGTH);

// toBase62 encodes a counter value into the base62 alphabet. A monotonic
// counter encoded this way is unique by construction: zero lookups on write.
export function toBase62(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('counter must be a non-negative safe integer');
  }
  let s = '';
  do {
    s = BASE62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s.padStart(CODE_LENGTH, BASE62[0]);
}

// makeRng returns a deterministic PRNG (mulberry32) so every lab run,
// test, and browser session can replay identical traffic.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// randomCode draws a code from the base62 alphabet. Uniqueness is NOT
// guaranteed — every draw must be checked against the store before use.
export function randomCode(rng: () => number, len: number = CODE_LENGTH): string {
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[Math.floor(rng() * 62)];
  return s;
}

// --- Types ------------------------------------------------------------------

export type CodeStrategy = 'counter' | 'random';
export type RedirectStatus = 301 | 302;
export type AnalyticsMode = 'inline' | 'queued';
export type ServedBy = 'browser-cache' | 'edge-cache' | 'database' | 'none';

// LATENCY models milliseconds per hop. One honest scale so the UI's path
// visualisation means something: a cache read is cheap, a DB write is not.
export const LATENCY = {
  edge: 1, // gateway / load-balancer hop
  app: 2, // app server handling
  cacheRead: 1, // Redis-style in-memory read
  dbRead: 8, // database SELECT round trip
  dbWrite: 12, // database INSERT/UPDATE round trip
  browserCache: 0, // resolved locally — no request is even sent
} as const;

export interface Step {
  component: string;
  action: string;
  latencyMs: number;
}

export interface ShortenResult {
  code: string;
  longUrl: string;
  strategy: CodeStrategy;
  attempts: number;
  collisionLookups: number;
  latencyMs: number;
  steps: Step[];
}

export interface ResolveResult {
  status: number;
  location: string | null;
  servedBy: ServedBy;
  clickCounted: boolean;
  latencyMs: number;
  steps: Step[];
}

export interface LabStats {
  codesIssued: number;
  dbWrites: number;
  dbReads: number;
  cacheHits: number;
  cacheMisses: number;
  collisionLookups: number;
  queuedEvents: number;
  clicksCounted: number;
  redirectsServed: number;
  browserCacheHits: number;
}

export interface LabLink {
  code: string;
  longUrl: string;
}

// --- The lab ----------------------------------------------------------------

export interface LabOptions {
  seed?: number;
  // riggedCollisions forces the random strategy to re-draw already-issued
  // codes for its first N attempts — the collision-lookup failure mode,
  // reproducible on demand instead of by luck.
  riggedCollisions?: number;
}

export interface Lab {
  shorten(longUrl: string, opts?: { strategy?: CodeStrategy }): ShortenResult;
  resolve(code: string, opts?: { status?: RedirectStatus; analytics?: AnalyticsMode }): ResolveResult;
  links(): LabLink[];
  stats(): LabStats;
  // rig arms the next n random-strategy draws to collide with an existing
  // code — reproduces the collision-lookup failure mode on demand.
  rig(n: number): void;
  reset(): void;
}

export function createLab(options: LabOptions = {}): Lab {
  let store: Map<string, string>;
  let edgeCache: Map<string, string>;
  let browserCache: Set<string>;
  let issued: string[];
  let counter: number;
  let rng: () => number;
  let rigged: number;
  let stats: LabStats;

  function freshStats(): LabStats {
    return {
      codesIssued: 0, dbWrites: 0, dbReads: 0,
      cacheHits: 0, cacheMisses: 0, collisionLookups: 0,
      queuedEvents: 0, clicksCounted: 0,
      redirectsServed: 0, browserCacheHits: 0,
    };
  }

  function reset(): void {
    store = new Map();
    edgeCache = new Map();
    browserCache = new Set();
    issued = [];
    counter = 0;
    rng = makeRng(options.seed ?? 1);
    rigged = options.riggedCollisions ?? 0;
    stats = freshStats();
  }

  function pickCandidate(): string {
    // Rigged draw: deliberately return an already-issued code so the
    // collision check fails and the cost becomes visible.
    if (rigged > 0 && issued.length > 0) {
      rigged--;
      return issued[rigged % issued.length];
    }
    return randomCode(rng);
  }

  function shorten(longUrl: string, opts: { strategy?: CodeStrategy } = {}): ShortenResult {
    const strategy = opts.strategy ?? 'counter';
    const steps: Step[] = [
      { component: 'client', action: 'POST /links', latencyMs: LATENCY.edge },
      { component: 'app', action: 'load balancer → app server validates the URL', latencyMs: LATENCY.app },
    ];
    let code = '';
    let attempts = 0;

    if (strategy === 'counter') {
      counter += 1;
      code = toBase62(counter);
      steps.push({
        component: 'keygen',
        action: `counter ${counter} → base62 "${code}" — unique by construction, no lookup`,
        latencyMs: 0,
      });
    } else {
      // Random strategy: every draw must be checked against the store.
      do {
        attempts++;
        code = pickCandidate();
        steps.push({
          component: 'db',
          action: `collision check: SELECT 1 FROM links WHERE code = '${code}'`,
          latencyMs: LATENCY.dbRead,
        });
        stats.collisionLookups++;
        stats.dbReads++;
      } while (store.has(code));
      steps.push({
        component: 'keygen',
        action: attempts === 1
          ? `"${code}" is free — write may proceed`
          : `"${code}" is free after ${attempts} attempts — retries burned ${attempts} extra round trip(s)`,
        latencyMs: 0,
      });
    }

    steps.push({
      component: 'db',
      action: `INSERT INTO links (code, long_url) VALUES ('${code}', …)`,
      latencyMs: LATENCY.dbWrite,
    });
    stats.dbWrites++;
    store.set(code, longUrl);
    issued.push(code);
    edgeCache.set(code, longUrl); // write-through: a fresh link is a hot link
    stats.codesIssued++;

    return {
      code, longUrl, strategy, attempts: Math.max(attempts, 1),
      collisionLookups: strategy === 'random' ? attempts : 0,
      latencyMs: steps.reduce((t, s) => t + s.latencyMs, 0),
      steps,
    };
  }

  function resolve(code: string, opts: { status?: RedirectStatus; analytics?: AnalyticsMode } = {}): ResolveResult {
    const status: RedirectStatus = opts.status ?? 302;
    const analytics: AnalyticsMode = opts.analytics ?? 'queued';
    const steps: Step[] = [];

    // The 301 trap: once a browser has seen a permanent redirect for this
    // code, later clicks resolve locally. The request never leaves the
    // browser — no click event, no cache read, nothing.
    if (status === 301 && browserCache.has(code)) {
      steps.push({
        component: 'browser',
        action: `cached 301 for /${code} — redirect resolved locally, the server never sees this click`,
        latencyMs: LATENCY.browserCache,
      });
      stats.browserCacheHits++;
      return {
        status, location: store.get(code) ?? null,
        servedBy: 'browser-cache', clickCounted: false, latencyMs: 0, steps,
      };
    }

    steps.push({ component: 'edge', action: `GET /${code} reaches the gateway`, latencyMs: LATENCY.edge });
    steps.push({ component: 'app', action: 'app server begins the read path', latencyMs: LATENCY.app });

    let clickCounted = false;
    if (analytics === 'inline') {
      // The popular-diagram bug: a click-row INSERT inside the read path.
      // Redirect latency is now a database write.
      steps.push({
        component: 'analytics-db',
        action: 'INSERT INTO clicks — blocks the redirect (analytics in the read path)',
        latencyMs: LATENCY.dbWrite,
      });
      stats.dbWrites++;
      stats.clicksCounted++;
      clickCounted = true;
    }

    let location: string | null = null;
    let servedBy: ServedBy = 'database';
    if (edgeCache.has(code)) {
      steps.push({ component: 'cache', action: `cache hit: ${code} → long URL`, latencyMs: LATENCY.cacheRead });
      stats.cacheHits++;
      location = edgeCache.get(code) ?? null;
      servedBy = 'edge-cache';
    } else {
      steps.push({ component: 'cache', action: 'cache miss', latencyMs: LATENCY.cacheRead });
      stats.cacheMisses++;
      steps.push({
        component: 'db',
        action: `SELECT long_url FROM links WHERE code = '${code}' — then populate the cache`,
        latencyMs: LATENCY.dbRead,
      });
      stats.dbReads++;
      location = store.get(code) ?? null;
      if (location !== null) edgeCache.set(code, location);
    }

    if (location === null) {
      steps.push({ component: 'edge', action: '404 — unknown code', latencyMs: 0 });
      return {
        status: 404, location: null, servedBy: 'none',
        clickCounted: false,
        latencyMs: steps.reduce((t, s) => t + s.latencyMs, 0), steps,
      };
    }

    if (analytics === 'queued') {
      // Fire-and-forget into a durable queue; a consumer counts the click
      // after the user has already been redirected.
      steps.push({
        component: 'queue',
        action: 'publish click event — counted asynchronously, off the read path',
        latencyMs: 0,
      });
      stats.queuedEvents++;
      stats.clicksCounted++;
      clickCounted = true;
    }

    steps.push({ component: 'edge', action: `${status} → ${location}`, latencyMs: 0 });
    stats.redirectsServed++;
    if (status === 301) {
      browserCache.add(code);
      steps.push({
        component: 'browser',
        action: 'browser records the 301 as permanent — future clicks may never reach the server',
        latencyMs: 0,
      });
    }

    return {
      status, location, servedBy, clickCounted,
      latencyMs: steps.reduce((t, s) => t + s.latencyMs, 0), steps,
    };
  }

  reset();
  return {
    shorten, resolve,
    links: () => issued.map(code => ({ code, longUrl: store.get(code) ?? '' })),
    stats: () => ({ ...stats }),
    rig: (n: number) => { rigged += Math.max(0, Math.floor(n)); },
    reset,
  };
}

// simulateReads fires n resolve() calls in a deterministic traffic mix:
// `hotShare` of requests hit the first (viral) code, the rest spread across
// the remaining codes. This is how a >95% cache hit rate happens in real
// traffic — a handful of links carry almost all the clicks.
export function simulateReads(
  lab: Lab,
  codes: string[],
  n: number,
  opts: { status?: RedirectStatus; analytics?: AnalyticsMode; hotShare?: number } = {},
): { results: ResolveResult[]; hitRate: number; avgLatencyMs: number; clicksCounted: number } {
  const hotShare = opts.hotShare ?? 0.9;
  const results: ResolveResult[] = [];
  const rng = makeRng(97);
  for (let i = 0; i < n; i++) {
    const code = rng() < hotShare || codes.length === 1
      ? codes[0]
      : codes[1 + Math.floor(rng() * (codes.length - 1))];
    results.push(lab.resolve(code, opts));
  }
  const s = lab.stats();
  const hits = s.cacheHits;
  const total = hits + s.cacheMisses;
  return {
    results,
    hitRate: total === 0 ? 0 : hits / total,
    avgLatencyMs: results.reduce((t, r) => t + r.latencyMs, 0) / results.length,
    clicksCounted: results.filter(r => r.clickCounted).length,
  };
}
