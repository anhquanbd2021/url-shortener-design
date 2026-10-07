# Shortener Lab — companion demo

Interactive lab for the article *The Short Link That Redirected Fine — and
Counted Nothing*. Replay the four decisions that sink URL shorteners: how the
short code is minted, what the write and read paths touch, where analytics
sits, and whether you return `301` or `302`.

Zero dependencies — Node 24+ only. The domain model is a single TypeScript
module (`app/shortener.ts`) shared by the server, the browser UI (served
type-stripped at `/app/shortener.js`), and the test suite.

## Two tabs

- **Lab** (`/`) — the interactive demo: mint codes with a counter vs a
  riggable random draw, fire skewed traffic at the read path, compare inline
  vs queued analytics, and watch `301` clicks vanish into the browser cache.
- **Guide** (`/guide.html`) — what each feature proves and the key detail
  behind it, mined from the article.

## What it proves

| Claim | How the lab proves it |
|---|---|
| **A counter beats dice** | Shorten 200 links with the counter strategy — zero collision lookups. Switch to random, enable *rig collisions*, and watch extra `SELECT` round trips pile up before every insert. |
| **A redirect is one cache read** | Fire 100 clicks with 90% aimed at one hot link: the cache absorbs >90% of them and the DB is only touched on misses. |
| **Analytics goes after the redirect** | Compare 100 clicks each way: an inline `INSERT INTO clicks` adds a full DB write (~12 ms) to every redirect; a queued event adds ~0 ms and still counts. |
| **`301` is a one-way door** | Send 10 repeat clicks per status. With `301`, one click is counted and nine resolve inside the browser cache — the server never sees them. With `302`, all ten arrive. |

## Run it

```text
npm start   # serve the lab on http://localhost:3000
npm test    # domain model + HTTP-level + e2e tests through the server
npm run check  # test
```

The server also exposes a real redirect endpoint — `POST /api/shorten`, then
open `GET /r/<code>?status=301|302` — so the mechanisms run over actual HTTP,
not just the in-page simulation. Open a `?status=301` link twice in the same
browser and the second request may never leave it.

## Honest limits

This is an **in-memory model of the architecture**, not a deployed shortener.
The store, cache, browser cache, and queue are `Map`s and `Set`s; latencies
are representative constants, not measurements. It exists to make the
article's claims legible — not to serve production traffic.

Repo: <https://github.com/anhquanbd2021/url-shortener-design>
