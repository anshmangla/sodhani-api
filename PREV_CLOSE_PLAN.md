# Previous Close & Percent Change — Remediation Plan

**Repos:** `sodhani-api` (E:\Sodhani\sodhani-api) + `sodhaniScrap` (E:\Sodhani\sodhaniScrap)
**Server:** `ssh azureuser@20.207.205.51` — systemd (`systemctl`), not pm2
**Status:** Phases 0-3 implemented and verified locally. Not yet deployed - section 6 is the remaining step.
**Date:** 2026-09-11

---

## 0. Scope

### In scope
| # | Item | Repo |
|---|---|---|
| P1 | Stop overwriting historical bars — give previous close its own column | both |
| P2 | Unify percent-change: every endpoint uses previous close | api |
| P3 | Fix `/indices/:code/constituents` returning 0% for all NSE stocks | api |
| P4 | Fix watchlist computing change vs. open instead of prev close | api |
| P5 | Delete the destructive `0010_cleanup_out_of_hours.sql` migration | api |
| P6 | Pin DB session timezone to UTC | both |

### Explicitly out of scope (your call)
| Item | Residual risk after this plan |
|---|---|
| **Holiday calendar** in `isMarketOpen()` | **Largely neutralised by P1.** Today the holiday bug is destructive: it overwrites T-1's real close with T-2's. Once prev close lives in its own column, the worst a weekday holiday can do is add one duplicate flat bar stamped with the holiday's date. Cosmetic, not corrupting. Safe to defer. |
| **`SUM(volume)` → per-day max** | Unchanged. `TtlTradgVol` and `TtlTrfVal` on `/quote`, `/quotes` and the weekly/monthly `/history` buckets remain overstated ~40× on any day that has intraday rows. Does not affect price or percent change. Tracked, not fixed here. |
| **BSE flat-stock coverage gap** | Unchanged. BSE-only scrips with 0% change appear in neither gainers nor losers, so they get no tick and no prev close that day. The `COALESCE` fallback in step 3.1 keeps them serving a sane (if stale) prev close rather than `NULL`. |

---

## 1. Answer first: does syncing prev close 80×/day cost too much?

**Yes — but the fix is not "poll less", it's "stop doing it as a separate step."**

### What it costs today

Per poll, `syncPreviousCloseNSE` (`nseLiveSync.ts:146`) and `syncPreviousCloseBSE` (`bseLiveSync.ts:272`) each:

1. **Build a ~100 KB SQL string** — a `VALUES` literal with ~3,400 (NSE) / ~4,200 (BSE) rows, parsed and planned from scratch every time.
2. **Run one correlated subquery per stock:**
   ```sql
   MAX(DATE(hp.record_date)) WHERE "FinInstrmId" = ps.fin_id AND DATE(hp.record_date) < CURRENT_DATE
   ```
   `DATE()` wraps the indexed column, which defeats `historical_prices_idx (FinInstrmId, record_date DESC)`. Instead of a backward index scan that stops at the first qualifying tuple (~1 page), Postgres reads **every tuple for that instrument** and filters. With Yahoo history back to 1990 plus accumulating intraday rows, that's roughly 2k–8k tuples per stock → order of **10–30M tuples touched per execution**, ×160 executions/day.
3. **Write ~7,600 `ON CONFLICT DO UPDATE` rows.** `previousClose` is *constant for the entire session*, so 79 of every 80 writes store a byte-identical value — yet each still creates a new row version. That's **~600k dead tuples/day on your hottest table**, plus the WAL to ship them, plus autovacuum churn.

Point 3 is the one that actually bites. CPU spikes you'd notice; index bloat on `historical_prices_idx` you wouldn't, until `/api/quote` latency has quietly doubled over a few weeks.

### Why P1 makes the question moot

**Both feeds already carry previous close in the same rows the main upsert writes.** `item.previousClose` sits next to `item.lastPrice` in the NSE payload; `item.prevdayclose` sits next to `item.ltradert` in the BSE payload. Once `prev_close` is a column, it rides along as one extra entry in a `VALUES` list you are already building.

Marginal cost of previous close after P1: **one extra column on one existing statement.** Zero extra round trips, zero extra scans, zero extra dead tuples. Running it 80×/day becomes free, and both `syncPreviousClose*` functions get deleted outright.

### Measure it yourself before and after

```bash
ssh azureuser@20.207.205.51
sudo -u postgres psql sodhani

-- how much history per stock (drives the scan cost in point 2)
SELECT round(avg(n)) avg_rows, max(n) max_rows FROM (
  SELECT count(*) n FROM historical_prices GROUP BY "FinInstrmId") s;

-- table + index bloat from the repeated rewrites
SELECT pg_size_pretty(pg_relation_size('historical_prices')) heap,
       pg_size_pretty(pg_relation_size('historical_prices_idx')) idx,
       n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'historical_prices';
```

Re-run the second query a week after deploying. `n_dead_tup` growth should drop sharply.

---

## 2. Phase 0 — Stop the bleeding (do first, 2 minutes)

**Delete `db/migrations/0010_cleanup_out_of_hours.sql`.**

It runs `DELETE FROM historical_prices WHERE EXTRACT(HOUR FROM record_date AT TIME ZONE 'UTC') < 9 OR >= 16`. Your `record_date` is stored as **UTC wall clock** (live syncs insert `new Date().toISOString()` into a `TIMESTAMP` column, so the `Z` is dropped and 09:18 IST lands as 03:48). That filter therefore deletes:

- **every `00:00` EOD bar** — all Yahoo history *and* every previously synced prev close, and
- **every intraday tick before 14:30 IST.**

It is untracked but sitting in `db/migrations/`, so the next `npm run migrate` picks it up. The file is currently the single largest risk in either repo.

If the original intent was to prune out-of-hours noise, the correct predicate for UTC-stored rows is `EXTRACT(HOUR ...) < 3 OR >= 11` — but write it as a new, separately reviewed migration.

---

## 3. Phase 1 — `prev_close` column (P1)

### 3.1 Migration — `db/migrations/0011_historical_prices_prev_close.sql`

```sql
ALTER TABLE historical_prices ADD COLUMN IF NOT EXISTS prev_close DECIMAL(14,6) NULL;
```

Nullable with no default → metadata-only change in PG 11+, no table rewrite, no lock of consequence. Safe on a live table.

Mirror the same `ADD COLUMN IF NOT EXISTS` into `sodhaniScrap/src/db/init.ts` (alongside the existing block at `init.ts:61-67`) so a fresh bootstrap creates it too.

### 3.2 Scraper — NSE (`src/services/nseLiveSync.ts`)

- In the loop at `:68-95`, append `parseFloat(item.previousClose) || null` as an 8th element of each `values` row.
- Add `prev_close` to the column list at `:104` and to the `DO UPDATE SET` at `:107-112` as `prev_close = COALESCE(EXCLUDED.prev_close, historical_prices.prev_close)`.
- **Delete `syncPreviousCloseNSE` entirely** (`:146-228`) and its call at `:119`.

### 3.3 Scraper — BSE (`src/services/bseLiveSync.ts`)

- In the loop at `:115-144`, append `parseFloat(item.prevdayclose) || null` to each `values` row.
- Add `prev_close` to the column list at `:164` and the `DO UPDATE SET` at `:167-172`, same `COALESCE` form.
- **Delete `syncPreviousCloseBSE` entirely** (`:272-361`) and its call at `:179`.
- **Keep the dual-listed precedence.** Today NSE wins for dual-listed stocks via the `nseCodes` skip at `:307`. With the ride-along write that skip disappears, so BSE would write `prev_close` first and NSE would overwrite it a moment later in the same cycle — same outcome, because `nseLiveSync` runs after `bseLiveSync` (`index.ts:37-38`). Verify this on a dual-listed name (TCS / `532540`) during the first live session; if you want it explicit rather than ordering-dependent, gate the BSE write with the same `nseCodes` set.

### 3.4 What this fixes

No historical bar is ever mutated again. That kills, in one change: gap-driven corruption of older closes, ex-date distortion where `close_price` went raw while `adj_close` stayed adjusted, the BSE/NSE mixed-series problem on dual-listed names, and the destructive half of the holiday bug.

### 3.5 Backfill (optional, scope it before deciding)

Existing damage is not recoverable from the live feeds — only Yahoo has the real closes. **Measure first:**

```sql
-- bars that look like an injected prev close: flat OHLC, zero volume, midnight
SELECT count(*) FROM historical_prices
WHERE volume = 0 AND open_price = close_price AND high_price = low_price
  AND EXTRACT(HOUR FROM record_date) = 0;
```

If that count is small, leave it. If it's large, the repair is to reset `last_record` for the affected instruments and let `fetchHistoricalCatchup` (`yahooHistory.ts:10`) re-pull — its upsert at `:56-59` overwrites OHLC unconditionally. Run it on a restored dump first; it is a multi-hour job across ~4,000 symbols and it re-hits Yahoo's rate limits.

---

## 4. Phase 2 — Percent change (P2/P3/P4)

**One rule: every percent change is `(last - prev_close) / prev_close × 100`.** Today there are four different formulas across five endpoints.

### 4.1 Shared resolution, with fallback

Define one snippet used everywhere. Prefer the feed value on today's rows; fall back to the existing historical lateral for stocks the feeds didn't cover (BSE flat scrips, Yahoo-only instruments):

```
COALESCE( <latest non-null prev_close among today's rows>, <existing hp_prev lateral> )
```

Add to the `hp_latest` lateral (`market.ts:284-298` and `:368-382`):
```sql
MAX(prev_close) AS true_prev_close   -- constant within a day; MAX ignores NULLs
```
Keep the `hp_prev` lateral (`:300-314`, `:384-398`) as the fallback arm — including its midnight-row preference at `:310-312`, which still matters for the injected bars already in the database.

### 4.2 Endpoint-by-endpoint

| Endpoint | File:line | Today | Change |
|---|---|---|---|
| `/quote/:symbol` | `market.ts:277-282` | prev close ✅ | Swap base to the 4.1 `COALESCE`. Behaviour identical, drops the expensive lateral to a fallback-only path. |
| `/quotes` | `market.ts:361-366` | prev close ✅ | Same. |
| `/watchlist*` | `watchlist.ts:16-30`, `77-81`, `337-341` | **vs. today's open** 🔴 | Add `prev_close` to `PRICE_LATERAL`, recompute `change` and `change_percent` against it. Fixes the watchlist and quote screens disagreeing on the same stock. Note `true_open` isn't even the real open — it's the 09:18 snapshot, since the 09:15 open is never captured. |
| `/indices/:code/constituents` | `market.ts:1411-1415` | **always 0 for NSE** 🔴 | Root cause: `nseLiveSync` writes `open = high = low = close = lastPrice` and each poll gets a fresh `record_date`, so `ON CONFLICT` never fires and `close - open` is structurally 0. Since `nseLiveSync` runs last, every dual-listed and NSE-only stock is affected. Switch to `prev_close`; extend the lateral at `:1418` to select it. |
| `/history/:symbol` | `market.ts:589-591` | earliest bar's open 🟠 | Defensible for `1m`/`1y`/`5y`. **Wrong for `range=1d`** — special-case `1d` to use `prev_close` so the chart header matches the quote. Also fix the comment at `:586-587`, which claims parity with `/quote` that doesn't exist. |
| `/indices/:code/history` | `market.ts:1369-1374` | earliest tick in window 🟠 | `nse_index_history` / `bse_index_history` already store a proper `prev_close` per row (`nseIndicesSync.ts:184-195` — this is the pattern P1 copies). For `range=1d`, use `history[0].prev_close` instead of the earliest value, so the response's `change_percent` stops contradicting `history[0].change_pct`. |

### 4.3 Frontend contract

`ChangeVal` / `ChangePercent` keys and types are unchanged everywhere. Only the *values* move — watchlist and constituents will start returning meaningfully different numbers. Worth a heads-up to whoever owns the UI before deploy.

---

## 5. Phase 3 — Timezone pinning (P6)

`record_date` is `TIMESTAMP` (no tz) holding UTC wall clock, while `CURRENT_DATE` resolves in the **session** timezone. Correct only while that session is UTC. If it's ever set west of UTC, every date-boundary comparison in both repos shifts by a day.

```sql
ALTER DATABASE sodhani SET timezone = 'UTC';
-- verify (new session):
SELECT current_setting('TimeZone'), now(), CURRENT_DATE;
```

Belt and braces — add to both pools (`sodhaniScrap/src/db/pool.ts`, `sodhani-api/src/db/pool.ts`):

```ts
options: '-c timezone=UTC'
```

Requires a restart of every service to take effect.

---

## 6. Deployment (systemd, Azure)

### 6.1 The units

Confirmed on the box:

| Unit | Role | Touched by this deploy |
|---|---|---|
| `sodhaniscrap.service` | Market Data Ingestion Daemon — runs `bseLiveSync` / `nseLiveSync` | **Yes** — both live syncs changed |
| `sodhani-api.service` | Read-only market-data API | **Yes** — percent-change queries changed |
| `sodhaniscrap-indices.service` | BSE/NSE indices worker | Restart only (UTC session pin) |
| `sodhaniscrap-announcements.service` | Announcements worker | Restart only |
| `sodhaniscrap-metrics.service` | Daily metrics calculator (9 PM) | Restart only |
| `sodhaniscrap-spurt.service` | Spurt volume scraper | Restart only |
| `sodhaniscrap-research-reports.service` | Research reports worker | Restart only |
| `sodhani-ipo.service`, `sodhani-screener.service` | IPO / screener updaters | Restart only |
| `sodhani-industry-pe.timer`, `sodhani-split-company-data.timer` | Timers | Nothing to do — next firing picks it up |

Every scraper worker shares `src/db/pool.ts`, so they all need a restart for the
`timezone=UTC` session pin (section 5) to take effect — but only
`sodhaniscrap.service` and `sodhani-api.service` have behaviour changes.

### 6.2 Order of operations

```bash
# 0. BACKUP FIRST — this plan alters a table every service writes to
ssh azureuser@20.207.205.51
pg_dump -Fc sodhani > ~/sodhani-$(date +%F-%H%M).dump
ls -lh ~/sodhani-*.dump

# 1. Stop the ingest daemon (leave the API up — reads still work against the old column set)
sudo systemctl stop sodhaniscrap.service

# 2. Migration + timezone
cd /opt/sodhani-api
git pull
rm -f db/migrations/0010_cleanup_out_of_hours.sql   # Phase 0, if it ever reached the server
npm run migrate
sudo -u postgres psql -c "ALTER DATABASE sodhani SET timezone='UTC';"

# 3. Scraper
cd /opt/sodhaniScrap    # confirm path via: systemctl cat sodhaniscrap.service
git pull && npm ci && npm run build
sudo systemctl start sodhaniscrap.service
sudo systemctl status sodhaniscrap.service
journalctl -u sodhaniscrap.service -f        # watch one full 5-min cycle

# 4. API
cd /opt/sodhani-api
npm ci && npm run build
sudo systemctl restart sodhani-api.service
sudo systemctl status sodhani-api.service
journalctl -u sodhani-api.service -n 100 --no-pager

# 5. Restart the remaining workers so they pick up the UTC session pin
sudo systemctl restart sodhaniscrap-indices.service sodhaniscrap-announcements.service   sodhaniscrap-metrics.service sodhaniscrap-spurt.service   sodhaniscrap-research-reports.service sodhani-ipo.service sodhani-screener.service
systemctl list-units --type=service | grep -i sodhani   # all should read active running
```

**Deploy during market hours** (09:18–16:10 IST, Mon–Fri) — you need a live poll to confirm `prev_close` is actually landing. Outside those hours `isMarketOpen()` short-circuits and you'll verify nothing.

### 6.3 Verification

```sql
-- prev_close populating on today's rows, both exchanges
SELECT "FinInstrmId", record_date, close_price, prev_close
FROM historical_prices
WHERE DATE(record_date) = CURRENT_DATE AND prev_close IS NOT NULL
ORDER BY record_date DESC LIMIT 20;

-- coverage: how many distinct instruments got one today
SELECT count(DISTINCT "FinInstrmId") FROM historical_prices
WHERE DATE(record_date) = CURRENT_DATE AND prev_close IS NOT NULL;
-- expect a few thousand; materially lower means the ride-along write is misfiring

-- dual-listed precedence: NSE should win for 532540 (TCS)
SELECT record_date, close_price, prev_close FROM historical_prices
WHERE "FinInstrmId" = '532540' ORDER BY record_date DESC LIMIT 5;

-- history is no longer being mutated: yesterday's bar must be untouched
SELECT record_date, open_price, high_price, low_price, close_price, volume
FROM historical_prices WHERE "FinInstrmId" = '500510'
ORDER BY record_date DESC LIMIT 10;
```

```bash
# all five paths must now agree on the same stock
curl -s localhost:4000/api/quote/TCS | jq '{PrevClosePric,ChangeVal,ChangePercent}'
curl -s 'localhost:4000/api/quotes?codes=532540,500510' | jq '.quotes[].ChangePercent'
curl -s 'localhost:4000/api/history/TCS?range=1d' | jq '.change_percent'
curl -s 'localhost:4000/api/indices/NIFTY%2050/constituents?src=nse' | jq '.constituents[:5]'
#   ^ the real test: these must no longer be all-zero
```

### 6.4 Rollback

The migration is additive, so code rollback alone is sufficient — the extra column is inert to the old code.

```bash
sudo systemctl stop sodhaniscrap.service
cd /opt/sodhani-api  && git checkout <previous-sha> && npm ci && npm run build && sudo systemctl restart sodhani-api.service
cd /opt/sodhaniScrap && git checkout <previous-sha> && npm ci && npm run build && sudo systemctl start sodhaniscrap.service
```

Only restore the dump if Phase 3.5's backfill was run and went wrong. Do **not** drop `prev_close` on rollback — leave it; it costs nothing and re-adding it means another migration.

---

## 7. Optional, not required

**Stamp NSE rows from the payload's own timestamp** instead of `new Date()` (`nseLiveSync.ts:66`). The response carries `timestamp: "11-Sep-2026 12:15:13"`, which on a non-trading day reports the *last session's* time — so stale data would upsert harmlessly onto the session it belongs to instead of fabricating a bar for today. That's most of the holiday-calendar benefit for a fraction of the work.

Caveat worth weighing before doing it: NSE's timestamp is **IST**, while `bseLiveSync` converts `dt_tm` to UTC via `toISOString()`. Parsing it wrong would put NSE rows on a different wall clock than BSE rows and silently split every dual-listed stock's day. It needs an explicit IST→UTC conversion and its own test. Deferrable.

---

## 8. Order of work

1. **Phase 0** — delete `0010_cleanup_out_of_hours.sql` (2 min, do today, independent of everything else)
2. **Phase 1** — `prev_close` column + ride-along writes + delete both `syncPreviousClose*` functions
3. **Phase 3** — timezone pinning (rides along with the same restart)
4. **Phase 2** — API percent-change unification (deploy after 2 has produced at least one full session of `prev_close` data, so the `COALESCE` fallback isn't carrying every request)
5. 3.5 backfill — only if the damage-scoping query justifies it

Steps 2 and 4 can ship in one window if you're comfortable; splitting them means the API keeps using the existing lateral fallback in between, which is correct, just slower.
