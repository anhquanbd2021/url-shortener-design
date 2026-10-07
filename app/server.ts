// Shortener Lab — zero-dependency HTTP server.
// Serves the UI, exposes the shared domain model to the browser as
// type-stripped JS, and provides a REAL redirect endpoint (/r/:code) so the
// mechanism runs over actual HTTP.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createLab } from './shortener.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnalyticsMode, CodeStrategy, RedirectStatus } from './shortener.ts';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATIC_FILES = new Map<string, [string, Buffer | null]>([
  ['/', ['text/html; charset=utf-8', readFileSync(join(PUBLIC, 'index.html'))]],
  ['/index.html', ['text/html; charset=utf-8', readFileSync(join(PUBLIC, 'index.html'))]],
  ['/guide.html', ['text/html; charset=utf-8', readFileSync(join(PUBLIC, 'guide.html'))]],
  ['/styles.css', ['text/css; charset=utf-8', readFileSync(join(PUBLIC, 'styles.css'))]],
  ['/pb-shell.css', ['text/css; charset=utf-8', readFileSync(join(PUBLIC, 'pb-shell.css'))]],
  ['/pb-back.css', ['text/css; charset=utf-8', readFileSync(join(PUBLIC, 'pb-back.css'))]],
  ['/app/app.js', ['text/javascript; charset=utf-8', readFileSync(join(PUBLIC, 'app.js'))]],
]);

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

// One lab instance per server — the same model the tests exercise.
const lab = createLab({ seed: 2024, riggedCollisions: 0 });

function send(res: ServerResponse, status: number, type: string, body: string | Buffer | undefined): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type }).end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => resolveBody(body));
    req.on('error', reject);
  });
}

function asStatus(v: string | null): RedirectStatus {
  return v === '301' ? 301 : 302;
}

function asAnalytics(v: string | null): AnalyticsMode {
  return v === 'inline' ? 'inline' : 'queued';
}

export function createStaticServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/health') {
      send(res, 200, 'text/plain; charset=utf-8', 'ok');
      return;
    }
    if (path === '/version') {
      sendJson(res, 200, {
        name: PACKAGE.name,
        version: PACKAGE.version,
        commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
      });
      return;
    }
    if (path === '/tokens.css') {
      send(res, 200, 'text/css; charset=utf-8', readFileSync(new URL('../tokens.css', import.meta.url)));
      return;
    }

    // --- API: the lab over real HTTP --------------------------------------
    if (path === '/api/shorten' && req.method === 'POST') {
      let payload: { url?: string; strategy?: CodeStrategy } = {};
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const longUrl = String(payload.url ?? '');
      if (!/^https?:\/\/\S+$/.test(longUrl)) {
        sendJson(res, 400, { error: 'url must start with http:// or https://' });
        return;
      }
      const strategy: CodeStrategy = payload.strategy === 'random' ? 'random' : 'counter';
      sendJson(res, 200, lab.shorten(longUrl, { strategy }));
      return;
    }
    if (path === '/api/stats') {
      sendJson(res, 200, { stats: lab.stats(), links: lab.links() });
      return;
    }
    if (path === '/api/reset' && req.method === 'POST') {
      lab.reset();
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- The real redirect endpoint ----------------------------------------
    // GET /r/<code>?status=301|302&analytics=inline|queued
    // Issues an actual HTTP redirect so browsers demonstrate the 301 cache
    // trap for real — click it twice and the second request never arrives.
    if (path.startsWith('/r/')) {
      const code = decodeURIComponent(path.slice(3));
      const result = lab.resolve(code, {
        status: asStatus(url.searchParams.get('status')),
        analytics: asAnalytics(url.searchParams.get('analytics')),
      });
      if (result.status === 404 || !result.location) {
        sendJson(res, 404, { error: 'unknown short code', code });
        return;
      }
      res.writeHead(result.status, { ...SECURITY_HEADERS, location: result.location }).end();
      return;
    }

    // --- The shared model, served as type-stripped JS -----------------------
    // The browser imports the SAME shortener.ts the tests exercise.
    if (path === '/app/shortener.js') {
      const src = readFileSync(fileURLToPath(new URL('./shortener.ts', import.meta.url)), 'utf8');
      send(res, 200, 'text/javascript; charset=utf-8', stripTypeScriptTypes(src, { mode: 'strip' }));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC_FILES.get(path);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  console.log(`Shortener Lab listening on ${server.address()?.port}`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
