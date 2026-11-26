import type { NextFunction, Request, Response } from 'express';

// Caching for the public, read-only data endpoints (market, investments, TA,
// peers). None of them look at who is asking, so one response can serve
// everyone. Two layers:
//
//  1. Cache-Control headers, so browsers reuse a response when the visitor
//     moves between pages instead of paying another round trip per widget.
//  2. A small in-process cache of JSON bodies, so a burst of visitors costs
//     one database query per TTL window instead of one per request.
//
// Only paths listed in CACHE_RULES are touched. Auth, watchlist, calls,
// payments and admin routes are never cached. Each response is cached under
// its full URL, so different query strings are cached separately.

type Rule = { pattern: RegExp; seconds: number };

// sodhaniScrap's live pollers refresh every few minutes (prev_close and
// change fields every 10 min), so 30s keeps live widgets effectively current.
// Anything built from daily bars, filings or monthly fund data changes at
// most a few times a day.
const LIVE = 30;
const INTRADAY = 60;
const DAILY = 300;

// Paths are relative to the /api mount point.
export const CACHE_RULES: Rule[] = [
  { pattern: /^\/(top-gainers|top-losers|volume-shockers|quotes?)(\/|$)/, seconds: LIVE },
  { pattern: /^\/indices\/?$/, seconds: LIVE },
  { pattern: /^\/indices\/[^/]+\/history\/?$/, seconds: INTRADAY },
  { pattern: /^\/(history|volume)\//, seconds: INTRADAY },
  {
    pattern:
      /^\/(recent-results|recent-ipos|research-reports|announcements|screener|technical|metrics|stocks|static-stock|static-stock-consolidated|ta|company|investments)(\/|$)/,
    seconds: DAILY,
  },
  { pattern: /^\/indices\/[^/]+\/constituents\/?$/, seconds: DAILY },
];

const MAX_ENTRIES = 1000;

type Entry = { body: unknown; expires: number };
const store = new Map<string, Entry>();

// The in-process layer is off under tests: suites seed and mutate the
// database between requests and expect to read their own writes.
const memoryEnabled = () =>
  process.env.NODE_ENV !== 'test' || process.env.RESPONSE_CACHE_IN_TESTS === '1';

export function clearResponseCache(): void {
  store.clear();
}

function ruleFor(path: string): Rule | undefined {
  return CACHE_RULES.find((r) => r.pattern.test(path));
}

function cacheControl(seconds: number): string {
  // stale-while-revalidate lets the browser show the last copy instantly
  // and refresh in the background for a few more minutes.
  return `public, max-age=${seconds}, stale-while-revalidate=${seconds * 10}`;
}

export function responseCache(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const rule = ruleFor(req.path);
  if (!rule) return next();

  const key = req.originalUrl;
  const useMemory = memoryEnabled();

  if (useMemory) {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) {
      // Re-insert so the Map's insertion order tracks recency (LRU eviction).
      store.delete(key);
      store.set(key, hit);
      const age = Math.max(0, rule.seconds - Math.ceil((hit.expires - Date.now()) / 1000));
      res.setHeader('Cache-Control', cacheControl(rule.seconds));
      res.setHeader('Age', String(age));
      res.setHeader('X-Cache', 'HIT');
      res.json(hit.body);
      return;
    }
    if (hit) store.delete(key);
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    // Errors and empty/validation responses must not be pinned for everyone.
    if (res.statusCode === 200) {
      if (!res.getHeader('Cache-Control')) {
        res.setHeader('Cache-Control', cacheControl(rule.seconds));
      }
      if (useMemory) {
        res.setHeader('X-Cache', 'MISS');
        store.set(key, { body, expires: Date.now() + rule.seconds * 1000 });
        if (store.size > MAX_ENTRIES) {
          const oldest = store.keys().next().value;
          if (oldest !== undefined) store.delete(oldest);
        }
      }
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    return originalJson(body);
  };

  next();
}
