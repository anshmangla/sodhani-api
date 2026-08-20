# sodhani-api

A small REST API over the PostgreSQL database that [`sodhaniScrap`](https://github.com/Raman-pro/sodhaniScrap) populates. Market-data endpoints (`/api/*`) are read-only — they just query the tables `sodhaniScrap` keeps in sync and serve them as JSON: top gainers/losers, volume shockers, price/volume quotes, historical OHLCV data, and BSE announcements. Authentication endpoints (`/api/auth/*`) are the exception: they own a `users` table in the same database and are the app's only write path (see [Authentication](#authentication) below).

This repo also hosts the **Research Analyst (RA) dashboard and paid-calls** feature: Research Analysts (a separate identity from regular `users`, authenticated via their own JWT) publish "research calls" (Buy/Hold/Sell recommendations on a stock), optionally gated behind a Razorpay payment, and consumers browse/purchase them. See [Research Analyst Dashboard and Paid Calls](#research-analyst-dashboard-and-paid-calls) below.

## Architecture

```
BSE India APIs / Yahoo Finance
        │
        ▼
  sodhaniScrap (Node daemon, systemd: sodhaniscrap / sodhaniscrap-announcements)
        │  writes to
        ▼
  PostgreSQL  (shared database)
        ▲  reads (market data) / reads+writes (users table)
        │
  sodhani-api (this repo, systemd: sodhani-api, port 4000, behind nginx on :80)
        │
        ▼
   HTTP clients (frontend, curl, etc.)
```

Both services run on the same VM and point at the **same** `DATABASE_URL`. `sodhani-api` only issues `SELECT` queries against the market-data tables `sodhaniScrap` owns; it owns the `users` table itself and is free to write to it via `/api/auth/*`.

## Tech stack

- Node.js + TypeScript
- Express
- `pg` (raw parameterized SQL, no ORM)
- nginx as a reverse proxy in front of it (the app itself only binds to `127.0.0.1`)

## Project layout

```
src/
├── index.ts           # entry point — starts the HTTP server
├── app.ts              # Express app, middleware, route mounting, 404/error handlers
├── db/pool.ts           # pg connection pool (reads DATABASE_URL)
├── auth/
│   ├── jwt.ts            # signAuthToken / verifyAuthToken (session JWTs, consumer users)
│   ├── msg91.ts          # verifyMsg91AccessToken (phone OTP verification)
│   ├── google.ts         # verifyGoogleIdToken (Google ID token verification)
│   ├── middleware.ts     # requireAuth Express middleware (consumer users)
│   ├── raJwt.ts          # signRaAuthToken / verifyRaAuthToken (RA session JWTs)
│   └── raMiddleware.ts   # requireRaAuth Express middleware (Research Analysts)
├── data/
│   └── companies.ts      # searchCompanies — reads companies.csv, used by /api/ra/companies
├── services/
│   ├── razorpayService.ts  # createOrder, verifyCheckoutSignature, verifyWebhookSignature
│   └── purchaseService.ts  # completePurchase — shared idempotent purchase-grant transaction
└── routes/
    ├── market.ts         # all /api/* market-data route handlers (read-only)
    ├── auth.ts           # all /api/auth/* route handlers (reads + writes users)
    ├── raAuth.ts         # /api/ra/login, /change-password, /me, /logout (RA identity)
    ├── raCalls.ts        # /api/ra/companies, /calls, /calls/mine, /dashboard, comments, status
    ├── calls.ts          # /api/calls/* — public call browsing (list/detail/comments)
    ├── payments.ts       # /api/payments/order, /verify — Razorpay checkout flow
    ├── paymentsWebhook.ts # /api/payments/webhook — Razorpay server-to-server webhook
    └── myCalls.ts        # /api/me/calls, /calls/:id/comments — a consumer's purchased calls
db/
└── migrations/
    ├── 0001_create_users.sql        # creates the users table
    ├── 0002_research_analysts.sql   # creates the research_analysts table
    └── 0003_research_calls.sql      # creates research_calls, call_comments, payments, purchased_calls
scripts/
├── seed-research-analysts.ts  # npm run seed:ra — creates dummy RA dev accounts
└── verify-ra-transfers.ts     # npm run verify:ra-transfers — ad-hoc verification script for the RA transfers/earnings ledger, run against a real dev database
deploy/
└── sodhani-api.service  # systemd unit file used on the VM
```

## Data source tables

| Table | Populated by | Used by |
|---|---|---|
| `bse_top_gainers_losers` | `sodhaniScrap` live poll of BSE's full market gainers/losers feed | `/api/top-gainers`, `/api/top-losers` |
| `bse_spurt_volume` | `sodhaniScrap` live poll of BSE's spurt-volume feed | `/api/volume-shockers` |
| `company_stock` | `sodhaniScrap` bootstrap from `companies.json` (a curated **BSE-only watchlist**, currently ~2,359 companies) + bhavcopy | `/api/quote`, `/api/history`, `/api/stocks` |
| `historical_prices` | `sodhaniScrap` Yahoo Finance historical catch-up, keyed to the same watchlist | `/api/history` |
| `bse_announcements` | `sodhaniScrap` incremental BSE announcements sync | `/api/announcements` |
| `bse_indices` | `sodhaniScrap` BSE indices worker (master list of SENSEX + ~77 sectoral/thematic indices) | `/api/indices`, `/api/indices/:code/history` |
| `bse_index_history` | `sodhaniScrap` BSE indices worker (unified daily-close + intraday-tick series) | `/api/indices`, `/api/indices/:code/history` |
| `bse_index_constituents` | `sodhaniScrap` BSE index constituents sync (BSE HeatMapData feed, capped at 30 rows/index upstream) | `/api/indices/:code/constituents` |
| `nse_indices` | `sodhaniScrap` NSE indices worker (NIFTY 50, BANK, FIN SERVICE, FPI 150, MID SELECT, NEXT 50) | `/api/indices`, `/api/indices/:code/history` |
| `nse_index_history` | `sodhaniScrap` NSE indices worker (daily-close + intraday-tick series, plus market breadth) | `/api/indices`, `/api/indices/:code/history` |
| `nse_index_constituents` | `sodhaniScrap` NSE indices worker (full constituent list per index) | `/api/indices/:code/constituents` |

**Important scope note:** `bse_top_gainers_losers` and `bse_spurt_volume` cover the *entire* BSE live market — any listed stock can show up there. `company_stock`/`historical_prices` only cover the fixed watchlist in `sodhaniScrap`'s `companies.json` (`bse_only` list). So a ticker that appears in `/api/top-gainers` today (e.g. some small-cap that hit its circuit) may return `404` from `/api/quote` or `/api/history` if it isn't in that watchlist. This is expected — to fix it, the watchlist in `sodhaniScrap` itself would need to be expanded, not this API.

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection string — **must match** `sodhaniScrap`'s `.env` exactly, same database | `postgresql://user:pass@localhost:5432/sodhanscrap` |
| `PORT` | Port the app listens on | `4000` |
| `HOST` | Interface to bind to (defaults to `127.0.0.1` — keep it that way so the app is only reachable through nginx, not directly from the internet) | `127.0.0.1` |
| `JWT_SECRET` | HMAC secret used to sign/verify session JWTs issued by `/api/auth/*`. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` | *(random hex string)* |
| `MSG91_AUTH_KEY` | MSG91 auth key, used server-side to verify OTP widget access tokens against MSG91's `verifyAccessToken` API | *(from MSG91 dashboard)* |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID, used as the audience when verifying Google ID tokens from `/api/auth/google` | *(from Google Cloud Console)* |
| `RA_JWT_SECRET` | HMAC secret used to sign/verify Research Analyst session JWTs issued by `/api/ra/login`. Separate from `JWT_SECRET` so RA and consumer sessions can't be swapped for one another. Generate the same way as `JWT_SECRET` | *(random hex string)* |
| `RAZORPAY_KEY_ID` | Razorpay API key ID, used to create checkout orders and returned to the client to initialize Razorpay Checkout | *(from Razorpay dashboard)* |
| `RAZORPAY_KEY_SECRET` | Razorpay API key secret, used server-side to create orders and verify checkout signatures | *(from Razorpay dashboard)* |
| `RAZORPAY_WEBHOOK_SECRET` | Separate secret configured on the Razorpay webhook itself, used to verify `POST /api/payments/webhook` signatures | *(from Razorpay dashboard — Webhooks settings)* |

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, MSG91_AUTH_KEY, GOOGLE_CLIENT_ID,
                        # RA_JWT_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
psql "$DATABASE_URL" -f db/migrations/0001_create_users.sql          # creates the users table
psql "$DATABASE_URL" -f db/migrations/0002_research_analysts.sql     # creates the research_analysts table
psql "$DATABASE_URL" -f db/migrations/0003_research_calls.sql        # creates research_calls, call_comments, payments, purchased_calls
psql "$DATABASE_URL" -f db/migrations/0004_ra_onboarding.sql         # renames username to email, adds razorpay_account_id/razorpay_stakeholder_id/onboarding_status to research_analysts
psql "$DATABASE_URL" -f db/migrations/0005_ra_transfers.sql          # creates ra_transfers (RA payout ledger)
psql "$DATABASE_URL" -f db/migrations/0006_ra_transfer_settlements.sql # adds settlement_status/razorpay_settlement_id/razorpay_settlement_utr/settled_at to ra_transfers
npm run seed:ra          # creates dummy RA dev accounts (see scripts/seed-research-analysts.ts)
npm run dev              # runs src/index.ts directly via ts-node
```

## Build & run in production

```bash
npm install
npm run build            # compiles src/ -> dist/
npm start                # node dist/index.js
```

## Deploying on the VM

1. Clone next to `sodhaniScrap`:
   ```bash
   cd /opt
   sudo git clone https://github.com/anshmangla/sodhani-api.git
   sudo chown -R $USER:$USER sodhani-api
   cd sodhani-api
   npm install
   cp .env.example .env   # set DATABASE_URL to the same value sodhaniScrap uses
   npm run build
   ```
2. Install the systemd service:
   ```bash
   sudo cp deploy/sodhani-api.service /etc/systemd/system/sodhani-api.service
   sudo nano /etc/systemd/system/sodhani-api.service   # confirm User= matches your VM username
   sudo systemctl daemon-reload
   sudo systemctl enable --now sodhani-api
   sudo systemctl status sodhani-api
   ```
3. Put nginx in front of it (reverse proxy `127.0.0.1:4000` on port 80) and make sure the Azure NSG allows inbound port 80. See `deploy/sodhani-api.service` and the project history for the exact nginx site config used.

### Updating after a code change

```bash
cd /opt/sodhani-api
git pull origin main
npm run build
sudo systemctl restart sodhani-api
```

## API Reference

Base URL: `http://<vm-public-ip>/` (nginx proxies everything to the app on `127.0.0.1:4000`).

All responses are JSON. All list endpoints accept a `limit` query param, clamped server-side to a sane max — an out-of-range or missing value silently falls back to the default rather than erroring.

---

### `GET /health`

Liveness check.

**Response**
```json
{ "status": "ok" }
```

---

### `GET /api/top-gainers`

Today's top gaining stocks across the whole BSE market.

| Query param | Default | Max |
|---|---|---|
| `limit` | 10 | 50 |

**Response**
```json
{
  "count": 10,
  "gainers": [
    {
      "rank": 1,
      "scrip_cd": "541167",
      "scripname": "YASHO",
      "long_name": "Yasho Industries Ltd",
      "ltradert": "3862.2500",
      "change_val": "643.7000",
      "change_percent": "20.0000",
      "record_time": "2026-07-31T16:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/top-losers`

Same shape as `/api/top-gainers`, but for today's top losing stocks.

| Query param | Default | Max |
|---|---|---|
| `limit` | 10 | 50 |

**Response**
```json
{ "count": 10, "losers": [ { "rank": 1, "scrip_cd": "...", "scripname": "...", "long_name": "...", "ltradert": "...", "change_val": "...", "change_percent": "...", "record_time": "..." } ] }
```

---

### `GET /api/volume-shockers`

Stocks with the biggest jump in traded volume vs their weekly average, for the most recent trading day recorded.

| Query param | Default | Max |
|---|---|---|
| `limit` | 20 | 100 |

**Response**
```json
{
  "count": 20,
  "volume_shockers": [
    {
      "scrip_cd": "500325",
      "scripname": "RIL",
      "long_name": "Reliance Industries Ltd",
      "trd_vol": "1234567.0000",
      "wkavgqty": "234567.0000",
      "volumechangetimes": "5.2600",
      "ltradert": "2900.0000",
      "change_val": "45.0000",
      "change_percent": "1.5800",
      "turnover": "358000000.0000",
      "nsurl": "...",
      "record_date": "2026-07-31"
    }
  ]
}
```

---

### `GET /api/quote/:symbol`

Latest snapshot for one instrument in the tracked watchlist (`company_stock`). All price/volume/date fields are derived from that instrument's most recent day of data in `historical_prices` — `company_stock` is only used to resolve identity (`FinInstrmId`, `TckrSymb`, `FinInstrmNm`) and to match the `:symbol` lookup.

`:symbol` matches (case-insensitive) against the ticker (`TckrSymb`, e.g. `ANDHRAPET`) **or** the numeric BSE scrip code (`FinInstrmId`, e.g. `500012`).

**Example**
```
GET /api/quote/500012
GET /api/quote/ANDHRAPET
```

**Response**
```json
{
  "FinInstrmId": "500012",
  "TckrSymb": "ANDHRAPET",
  "FinInstrmNm": "ANDHRA PETROCHEMICALS LTD.",
  "LastPric": "...",
  "TtlTradgVol": "...",
  "TtlTrfVal": "...",
  "TradDt": "2026-07-22",
  "OpenPric": "...",
  "HighPric": "...",
  "LowPric": "...",
  "ClosePric": "...",
  "ChangeVal": "...",
  "ChangePercent": "..."
}
```

- `LastPric`/`ClosePric` — the latest day's close price from `historical_prices`.
- `TtlTradgVol` — `SUM(volume)` across that latest day's `historical_prices` rows.
- `TtlTrfVal` — approximated turnover, `TtlTradgVol × ClosePric` (`historical_prices` has no direct turnover column).
- `TradDt` — the latest `record_date` found in `historical_prices` for this instrument (replaces the old separate `TradDt`/`BizDt`/`ISIN`/`SctySrs`/`Sgmt`/`TtlNbOfTxsExctd` fields, which are no longer returned).
- If the instrument has no `historical_prices` rows yet (e.g. newly added to the watchlist, not yet backfilled), these fields come back `null`.

**404** if the symbol/scrip code isn't in the tracked watchlist:
```json
{ "error": "No quote found for symbol 'FOO'" }
```

---

### `GET /api/history/:symbol`

OHLCV history for one instrument, ordered chronologically (oldest to newest). Time-based bucketing is applied dynamically based on the requested range (e.g., weekly buckets for `1y` and `5y`, monthly for `max`). Data is downsampled to ~100 points via LTTB for `line` charts to optimize client-side rendering. Same `:symbol` matching rules as `/api/quote`.

| Query param | Default | Max | Description |
|---|---|---|---|
| `range` | `1m` | - | One of `1d`, `1w`, `1m`, `1y`, `5y`, `max`. Mutually exclusive with `start_date`/`end_date`. |
| `start_date` | - | - | YYYY-MM-DD. Requires `end_date`. |
| `end_date` | - | - | YYYY-MM-DD. Requires `start_date`. |
| `chartType` | `candlestick` | - | Either `candlestick` (returns raw/bucketed OHLCV) or `line` (applies LTTB downsampling returning only time and close_price). |

**Example**
```
GET /api/history/500012?range=1y&chartType=candlestick
```

**Response (chartType=candlestick)**
```json
{
  "symbol": "500012",
  "count": 52,
  "history": [
    {
      "time": "2026-07-31",
      "open_price": "...",
      "high_price": "...",
      "low_price": "...",
      "close_price": "...",
      "volume": "..."
    }
  ]
}
```

**Response (chartType=line)**
```json
{
  "symbol": "500012",
  "count": 100,
  "history": [
    {
      "time": "2026-07-31",
      "close_price": "..."
    }
  ]
}
```

**404** if there's no history for that symbol.

---

### `GET /api/stocks`

Search or list instruments in the tracked watchlist (`company_stock`).

| Query param | Default | Max |
|---|---|---|
| `search` | *(none — lists all, alphabetically)* | — |
| `limit` | 20 | 100 |

`search` matches (case-insensitive, substring) against ticker, company name, or ISIN, or an exact match against the numeric scrip code.

**Examples**
```
GET /api/stocks?search=goodricke
GET /api/stocks?search=500012
GET /api/stocks?limit=50
```

**Response**
```json
{
  "count": 1,
  "stocks": [
    {
      "FinInstrmId": "500166",
      "TckrSymb": "GOODRICKE",
      "FinInstrmNm": "GOODRICKE GROUP LTD.",
      "ISIN": "INE300A01016",
      "SctySrs": "...",
      "LastPric": "...",
      "TradDt": "2026-07-22"
    }
  ]
}
```

Note: this only searches the curated watchlist, not the full BSE market — see the scope note above.

---

### `GET /api/announcements`

Recent BSE corporate announcements/filings.

| Query param | Default | Max |
|---|---|---|
| `limit` | 20 | 100 |
| `scrip_cd` | *(none — all companies)* | — |

**Examples**
```
GET /api/announcements
GET /api/announcements?scrip_cd=500325&limit=10
```

**Response**
```json
{
  "count": 10,
  "announcements": [
    {
      "newsid": "a4d8...",
      "scrip_cd": "500325",
      "news_dt": "2026-07-24T10:00:00.000Z",
      "newssub": "Financial Results",
      "headline": "Outcome of Board Meeting",
      "slongname": "RELIANCE INDUSTRIES LTD.",
      "announcement_type": "C",
      "attachmentname": "...",
      "categoryname": "Company Update"
}
```

---

### `GET /api/static-stock`

Fetches static JSON file contents generated by `sodhaniScrap` for a specific stock from the `output_consolidated` or `output` directories.

| Query param | Default | Max |
|---|---|---|
| `query` | **(required)** | — |

`query` is matched (case-insensitive) against the file names in the output directories (with or without `.json` extension).

**Examples**
```
GET /api/static-stock?query=500012
GET /api/static-stock?query=3BBLACKBIO
```

**Response**
```json
{
  "ticker": "500012",
  "url": "https://www.screener.in/company/500012/consolidated/",
  "overview": {
    "company_name": "Andhra Petrochemicals Ltd",
    "current_price": "...",
    "about": "...",
    "website": "..."
  }
}
```

**404** if the static JSON file isn't found in either output directory:
```json
{ "error": "Static JSON not found for 'FOO'" }
```

---

### `GET /api/indices`

Latest entry for every index across **both exchanges** — BSE (SENSEX + ~77 sectoral/thematic
indices) and NSE (NIFTY 50, BANK, FIN SERVICE, FPI 150, MID SELECT, NEXT 50). Each row is that
index's daily bar, identified by `src`. NSE rows sort first, then alphabetically by name.

| Query param | Default | Notes |
|---|---|---|
| `src` | *(both)* | `bse` or `nse` to filter to one exchange. Any other value returns `400`. |

BSE rows also carry the legacy `sccode`/`scname` fields for back-compat. NSE rows carry live
market-breadth counts (`advances`/`declines`/`unchanged`) that BSE does not have; BSE rows carry
`prev_close`/`change_val`/`change_pct` refreshed every 10 minutes by `sodhaniScrap`'s live poller,
identified by `session` being `NULL` in the underlying `bse_index_history` table. `record_time` on
a daily-bar row is always midnight of the current day by convention; `updated_at` is the real
freshness timestamp.

**Response**
```json
{
  "count": 83,
  "indices": [
    {
      "src": "NSE",
      "code": "NIFTY 50",
      "name": "NIFTY 50",
      "sccode": null,
      "scname": null,
      "record_time": "2026-08-14T04:39:59.000Z",
      "value": 24366.00,
      "prev_close": 24395.85,
      "change_val": -29.85,
      "change_pct": -0.12,
      "advances": 10,
      "declines": 39,
      "unchanged": 1,
      "updated_at": "2026-08-14T14:10:36.182Z"
    },
    {
      "src": "BSE",
      "code": "16",
      "name": "BSE SENSEX",
      "sccode": "16",
      "scname": "BSE SENSEX",
      "record_time": "2026-08-13T00:00:00.000Z",
      "value": 77746.35,
      "prev_close": 77966.35,
      "change_val": -220.0,
      "change_pct": -0.2822,
      "advances": null,
      "declines": null,
      "unchanged": null,
      "updated_at": "2026-08-13T11:26:50.000Z"
    }
  ]
}
```

---

### `GET /api/indices/:code/history`

Historical or intraday series for a single index, either exchange.

| Query param | Default | Notes |
|---|---|---|
| `range` | `1d` | One of `1d`, `1w`, `6m`, `1y`. An unrecognized value falls back to `1d`. |
| `limit` | 5000 | Clamped to 20000. |
| `src` | *(auto)* | `bse` or `nse` to disambiguate explicitly. Normally unnecessary — see below. |

`:code` auto-resolves against both exchanges: BSE codes are numeric (`16`), NSE codes are index
names (`NIFTY 50`) and are matched case- and punctuation-insensitively, so `NIFTY%2050`,
`nifty-50`, and `NIFTY50` all resolve to the same index. There is no collision risk between the
two code spaces.

`range=1d` returns intraday ticks captured today, anchored to the index's own most recent entry
minus 24 hours. For BSE this is rows with `session` = `preopen`/`regular`; for NSE (which never
sets `session`) it's rows whose `record_time` isn't exactly midnight. `change_val`/`change_pct`
are `null` on BSE intraday rows (only the daily bar carries them); NSE rows carry them throughout.
All other ranges return daily bars — `1w` will typically only have a handful of points (one per
trading day in the window), which is expected, not a bug.

**Examples**
```
GET /api/indices/16/history?range=1y
GET /api/indices/NIFTY%2050/history?range=1d
GET /api/indices/nifty-50/history?range=1d&src=nse
```

**Response**
```json
{
  "src": "BSE",
  "code": "16",
  "name": "BSE SENSEX",
  "sccode": "16",
  "scname": "BSE SENSEX",
  "range": "1d",
  "count": 159,
  "change_percent": -0.28,
  "history": [
    { "record_time": "2026-08-13T06:06:40.000Z", "value": 77801.55, "prev_close": null, "change_val": null, "change_pct": null, "session": "regular", "advances": null, "declines": null, "unchanged": null }
  ]
}
```

**404** if `:code` doesn't match any known index on either exchange:
```json
{ "error": "Index '99999' not found" }
```

---

### `GET /api/indices/:code/constituents`

Member stocks for a single index, either exchange, joined to `company_stock` and each stock's
latest `historical_prices` row for last price / day change / volume. Same `:code` auto-resolution
and `?src=` override as the history route. Results are ordered by `change_percent` descending.

**BSE coverage caveat:** `bse_index_constituents` is scraped from BSE's public heatmap feed, which
always returns exactly 30 rows per index. For indices with 30 or fewer members (SENSEX, BANKEX,
the sectoral indices) this is the complete list. For broader indices (BSE 500, BSE 1000, …) it is
only that day's 30 biggest movers — **not** the full membership — and grows/rotates across sync
runs rather than representing a stable complete set. NSE constituents (`nse_index_constituents`)
have no such cap.

**Examples**
```
GET /api/indices/16/constituents
GET /api/indices/NIFTY%2050/constituents
```

**Response**
```json
{
  "src": "BSE",
  "code": "16",
  "name": "BSE SENSEX",
  "count": 30,
  "constituents": [
    {
      "FinInstrmId": "500820",
      "TckrSymb": "ASIANPAINT",
      "FinInstrmNm": "Asian Paints Ltd",
      "last_price": 2710.00,
      "change_percent": -1.69,
      "volume": 20722
    }
  ]
}
```

`count: 0` (not an error) if the index exists but has no synced membership yet. **404** if `:code`
doesn't match any known index.

---

## Authentication

Endpoints under `/api/auth/*` back the phone-OTP + Google sign-in flow used by `sodhani-web`. They read and write a `users` table (see `db/migrations/0001_create_users.sql`) in the same Postgres database as the market-data tables.

**Note on error shape:** market routes (`/api/*`) return errors as `{ "error": "..." }`. Auth routes (`/api/auth/*`) return errors as `{ "detail": "..." }` instead — a deliberate inconsistency, not an oversight, made to match `sodhani-web`'s existing `AuthContext.tsx` client, which already expects `detail`.

Session tokens are JWTs (`HS256`, signed with `JWT_SECRET`, 30-day expiry) carrying `{ sub: userId, token_version }`. `requireAuth` checks the token's `token_version` against the current value stored on the user row, so calling `/api/auth/logout` invalidates all previously issued tokens for that user immediately (no separate token blacklist needed).

---

### `POST /api/auth/check-phone`

Checks whether a phone number is already registered, before running the OTP flow.

**Body**
```json
{ "phone_number": "+919999999999", "flow": "signup" }
```
`flow` is `"signup"` or `"login"`.

**Response** `200`
```json
{ "ok": true }
```

**Errors**
- `400` `{ "detail": "phone_number and flow (login|signup) are required" }`
- `409` `{ "detail": "An account with this phone number already exists" }` — `flow: "signup"` and the number is already registered
- `404` `{ "detail": "No account found for this phone number" }` — `flow: "login"` and the number isn't registered

---

### `POST /api/auth/verify-otp-signup`

Verifies an MSG91 OTP widget access token and creates a new account.

**Body**
```json
{ "access_token": "...", "name": "Jane Doe", "age": 28, "email": "jane@example.com", "phone_number": "+919999999999" }
```
`email` is optional.

**Response** `201`
```json
{ "token": "<jwt>", "user": { "id": "...", "name": "Jane Doe", "age": 28, "email": "jane@example.com", "phone_number": "+919999999999" } }
```

**Errors**
- `400` `{ "detail": "access_token, name and phone_number are required" }`
- `401` `{ "detail": "OTP verification failed" }`
- `409` `{ "detail": "An account with this phone number already exists" }`

---

### `POST /api/auth/verify-otp-login`

Verifies an MSG91 OTP widget access token and logs an existing account in.

**Body**
```json
{ "access_token": "...", "phone_number": "+919999999999" }
```

**Response** `200`
```json
{ "token": "<jwt>", "user": { "id": "...", "name": "Jane Doe", "age": 28, "email": "jane@example.com", "phone_number": "+919999999999" } }
```

**Errors**
- `400` `{ "detail": "access_token and phone_number are required" }`
- `401` `{ "detail": "OTP verification failed" }`
- `404` `{ "detail": "No account found for this phone number" }`

---

### `POST /api/auth/google`

Verifies a Google ID token and finds-or-creates an account by (lowercased) email.

**Body**
```json
{ "credential": "<google id token>" }
```

**Response** `200`
```json
{ "token": "<jwt>", "user": { "id": "...", "name": "Jane Doe", "age": null, "email": "jane@example.com", "phone_number": null } }
```

**Errors**
- `400` `{ "detail": "credential is required" }`
- `401` `{ "detail": "Google sign-in verification failed" }`

---

### `GET /api/auth/me`

Returns the authenticated user. Requires `Authorization: Bearer <jwt>`.

**Response** `200`
```json
{ "user": { "id": "...", "name": "Jane Doe", "age": 28, "email": "jane@example.com", "phone_number": "+919999999999" } }
```

**Errors**
- `401` `{ "detail": "Missing or malformed Authorization header" }` / `{ "detail": "Invalid or expired token" }` / `{ "detail": "Token has been revoked" }`

---

### `POST /api/auth/logout`

Revokes all outstanding session tokens for the authenticated user by bumping `token_version`. Requires `Authorization: Bearer <jwt>`.

**Response** `200`
```json
{ "ok": true }
```

---

## Research Analyst Dashboard and Paid Calls

Research Analysts (RAs) are a separate identity from consumer `users` — they authenticate with their own username/password against the `research_analysts` table (see `db/migrations/0002_research_analysts.sql`) and carry their own session JWT, signed with `RA_JWT_SECRET` and verified by `requireRaAuth` (`src/auth/raMiddleware.ts`). An RA publishes "research calls" (`research_calls` table, `db/migrations/0003_research_calls.sql`) — a Buy/Hold/Sell recommendation on a stock — optionally gated behind a Razorpay payment (`is_paid` + `price_paise`). Consumers browse calls publicly, and purchase paid ones via Razorpay Checkout.

**Note on error shape:** like `/api/auth/*`, all `/api/ra/*` routes return errors as `{ "detail": "..." }`. The public/consumer-facing routes below (`/api/calls/*`, `/api/payments/*`, `/api/me/*`) follow the market-route convention instead and return `{ "error": "..." }`.

`requireRaAuth` also rejects (`401 { "detail": "Account is inactive" }`) any RA whose `is_active` flag has been turned off, and public call routes stop surfacing a deactivated RA's calls entirely (see below) — but an RA can still see and manage their own full history via `/api/ra/calls/mine` and `/api/ra/dashboard` even after deactivation, and a consumer who already purchased a call keeps access via `/api/me/calls` regardless of the RA's later status.

### RA authentication (`/api/ra/*`)

#### `POST /api/ra/login`

**Body**
```json
{ "username": "rajesh.kumar", "password": "ChangeMe123!" }
```

**Response** `200`
```json
{ "token": "<jwt>", "ra": { "id": "...", "username": "rajesh.kumar", "full_name": "Rajesh Kumar", "profile_picture_url": null, "designation": "Senior Research Analyst" } }
```

**Errors**
- `400` `{ "detail": "username and password are required" }`
- `401` `{ "detail": "Invalid username or password" }` / `{ "detail": "Account is inactive" }`

---

#### `POST /api/ra/change-password`

Requires `Authorization: Bearer <ra jwt>`. Bumps `token_version`, revoking all previously issued RA session tokens.

**Body**
```json
{ "current_password": "ChangeMe123!", "new_password": "NewPassword456!" }
```

**Response** `200`
```json
{ "ok": true }
```

**Errors**
- `400` `{ "detail": "current_password and new_password are required" }`
- `401` `{ "detail": "Current password is incorrect" }`

---

#### `GET /api/ra/me`

Returns the authenticated RA. Requires `Authorization: Bearer <ra jwt>`.

**Response** `200`
```json
{ "ra": { "id": "...", "username": "rajesh.kumar", "full_name": "Rajesh Kumar", "profile_picture_url": null, "designation": "Senior Research Analyst", "is_active": true } }
```

---

#### `POST /api/ra/logout`

Revokes all outstanding RA session tokens by bumping `token_version`. Requires `Authorization: Bearer <ra jwt>`.

**Response** `200`
```json
{ "ok": true }
```

---

### RA call management (`/api/ra/*`, all require `Authorization: Bearer <ra jwt>`)

#### `GET /api/ra/companies?search=`

Search the tracked company list (`companies.csv`, via `src/data/companies.ts`) to help an RA pick a `scrip_code`/`company_name` when creating a call. Returns `[]` for an empty/missing `search`.

**Response** `200`
```json
{ "companies": [ { "code": "500325", "name": "RELIANCE INDUSTRIES LTD" } ] }
```

---

#### `POST /api/ra/calls`

Creates a research call owned by the authenticated RA.

**Body**
```json
{
  "scrip_code": "500325",
  "company_name": "Reliance Industries Ltd",
  "recommendation": "Buy",
  "target_price": 3200.5,
  "stop_loss": 2800,
  "buying_range": "2900-2950",
  "holding_period": "6-12 months",
  "is_paid": true,
  "price_paise": 9900,
  "current_price_at_publish": 2905,
  "volume_at_publish": 1234567
}
```
`recommendation` must be one of `Buy`, `Hold`, `Sell`. `price_paise` is required (and must be a positive number) when `is_paid` is `true`; omit/leave `false` for a free call.

**Response** `201`
```json
{ "call": { "id": "...", "ra_id": "...", "scrip_code": "500325", "...": "..." } }
```

**Errors**
- `400` `{ "error": "scrip_code is required" }` / `{ "error": "company_name is required" }` / `{ "error": "recommendation must be one of 'Buy', 'Hold', 'Sell'" }` / `{ "error": "target_price is required and must be a number" }` / `{ "error": "price_paise is required and must be a positive number when is_paid is true" }`

---

#### `GET /api/ra/calls/mine`

All calls created by the authenticated RA, each annotated with its purchase count and lifetime revenue.

**Response** `200`
```json
{
  "calls": [
    { "id": "...", "scrip_code": "500325", "...": "...", "purchase_count": 42, "revenue_paise": "415800" }
  ]
}
```
Note: `revenue_paise` is a `bigint` in Postgres and comes back from `pg` as a numeric **string**, not a JS number — parse it client-side before doing arithmetic.

---

#### `GET /api/ra/dashboard`

Summary stats for the authenticated RA.

**Response** `200`
```json
{ "dashboard": { "total_calls": 12, "total_paid_calls": 5, "total_sales": 47 } }
```

---

#### `GET /api/ra/dashboard/earnings`

Route transfer earnings for the authenticated RA — money transferred to
their Razorpay linked account (not settlement-to-bank status). Sourced from
the `ra_transfers` table, populated by the `transfer.processed` /
`transfer.failed` webhook handlers in `paymentsWebhook.ts`. No historical
backfill — only reflects transfers received after this feature shipped.

**Response** `200`
```json
{
  "earnings": { "total_paise": 45000, "this_month_paise": 9000, "this_year_paise": 45000, "failed_transfer_count": 1 },
  "recent_payouts": [
    { "amount_paise": 4500, "processed_at": "2026-08-15T10:00:00.000Z", "call_id": "...", "company_name": "Reliance Industries Ltd.", "recommendation": "Buy" }
  ],
  "by_call": [
    { "call_id": "...", "company_name": "Reliance Industries Ltd.", "recommendation": "Buy", "total_paise": 9000, "count": 2 }
  ]
}
```

---

#### `POST /api/ra/calls/:id/comments`

Adds a comment/update to a call owned by the authenticated RA.

**Body**
```json
{ "body": "Company reported strong Q2 results, maintaining Buy." }
```

**Response** `201`
```json
{ "comment": { "id": "...", "call_id": "...", "ra_id": "...", "body": "...", "created_at": "..." } }
```

**Errors**
- `400` `{ "error": "body is required" }`
- `403` `{ "error": "Not your call" }` — the call exists but belongs to a different RA
- `404` `{ "error": "Call not found" }`

---

#### `GET /api/ra/calls/:id/comments`

Reads back all comments on a call owned by the authenticated RA, oldest first — the RA-side counterpart to `POST` above (an RA token can't satisfy the consumer-facing `GET /api/calls/:id/comments`, which requires purchase/entitlement instead of ownership).

**Response** `200`
```json
{ "comments": [ { "id": "...", "body": "...", "created_at": "..." } ] }
```

**Errors**
- `403` `{ "error": "Not your call" }`
- `404` `{ "error": "Call not found" }`

---

#### `PATCH /api/ra/calls/:id/status`

Marks a call owned by the authenticated RA as `open` or `closed`.

**Body**
```json
{ "status": "closed" }
```

**Response** `200`
```json
{ "call": { "id": "...", "status": "closed", "...": "..." } }
```

**Errors**
- `400` `{ "error": "status must be 'open' or 'closed'" }`
- `403` `{ "error": "Not your call" }`
- `404` `{ "error": "Call not found" }`

---

### Public call browsing (`/api/calls/*`)

Consumer-facing, read-only. `Authorization: Bearer <consumer jwt>` is optional on all three — it's used only to resolve purchase entitlement (an anonymous request is treated as not-purchased, never rejected). Calls belonging to a deactivated RA (`is_active = false`) are excluded from the list (`GET /api/calls`) and detail (`GET /api/calls/:id`) endpoints below entirely — they 404 the same as a nonexistent call.

A paid call (`is_paid: true`) that the caller hasn't purchased returns a **preview** payload (no `target_price`, `stop_loss`, `buying_range`, `holding_period`, `current_price_at_publish`, `volume_at_publish`, `updated_at`); a free call, or a paid call the caller has purchased, returns the **full** payload.

#### `GET /api/calls?page=&limit=`

| Query param | Default | Max |
|---|---|---|
| `page` | 1 | — |
| `limit` | 25 | 100 |

**Response** `200`
```json
{
  "data": [
    {
      "id": "...", "scrip_code": "500325", "company_name": "Reliance Industries Ltd",
      "recommendation": "Buy", "is_paid": true, "price_paise": 9900, "status": "open",
      "created_at": "...", "ra_name": "Rajesh Kumar", "ra_profile_picture_url": null,
      "ra_designation": "Senior Research Analyst", "purchased": false
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 25, "totalPages": 1 }
}
```

---

#### `GET /api/calls/:id`

**Response** `200`
```json
{ "call": { "id": "...", "...": "same shape as one element of /api/calls's data[]" } }
```

**Errors**
- `404` `{ "error": "Call not found" }`

---

#### `GET /api/calls/:id/comments`

Comments on a call, oldest first. Free calls: open to anyone. Paid calls: requires `Authorization: Bearer <consumer jwt>` for a user who has purchased the call.

**Response** `200`
```json
{ "comments": [ { "id": "...", "body": "...", "created_at": "..." } ] }
```

**Errors**
- `403` `{ "error": "Purchase required" }`
- `404` `{ "error": "Call not found" }`

---

### Payments (`/api/payments/*`, require `Authorization: Bearer <consumer jwt>`)

Razorpay checkout flow: `POST /order` creates a Razorpay order and a `payments` row (`status: 'created'`), the client runs Razorpay Checkout with the returned `order_id`/`key_id`, then `POST /verify` validates the checkout signature and grants access. Purchases are also completed idempotently via `POST /api/payments/webhook` (below) as a fallback if the client never calls `/verify`.

#### `POST /api/payments/order`

**Body**
```json
{ "call_id": "..." }
```

**Response** `201`
```json
{ "order_id": "order_...", "amount_paise": 9900, "key_id": "rzp_test_..." }
```
If the caller already owns the call: `200 { "already_purchased": true }` instead (no new order is created).

**Errors**
- `400` `{ "error": "call_id is required" }` / `{ "error": "This call is not a paid call" }` / `{ "error": "This call is no longer available for purchase" }` — the owning RA has been deactivated
- `404` `{ "error": "Call not found" }`

---

#### `POST /api/payments/verify`

**Body**
```json
{ "razorpay_order_id": "order_...", "razorpay_payment_id": "pay_...", "razorpay_signature": "..." }
```

**Response** `200`
```json
{ "ok": true, "purchased": true, "already_processed": false }
```

**Errors**
- `400` `{ "error": "razorpay_order_id, razorpay_payment_id and razorpay_signature are required" }` / `{ "error": "Invalid payment signature" }` / `{ "error": "Unable to verify purchase" }`

---

### Payments webhook

#### `POST /api/payments/webhook`

Razorpay server-to-server webhook (not called by the frontend). Verifies `X-Razorpay-Signature` against `RAZORPAY_WEBHOOK_SECRET` over the raw request body, then completes the purchase for `payment.captured` events via the same idempotent path as `/api/payments/verify`. Always responds `200 { "received": true }` once the signature checks out — including when the event type is ignored or downstream processing fails — per Razorpay's retry semantics (a non-2xx response triggers indefinite retries).

**Errors**
- `400` `{ "error": "Invalid signature" }`

---

### My calls (`/api/me/*`, require `Authorization: Bearer <consumer jwt>`)

#### `GET /api/me/calls`

All calls the authenticated user has purchased, newest purchase first, always as the full (non-preview) payload — regardless of the owning RA's later `is_active` status.

**Response** `200`
```json
{ "calls": [ { "id": "...", "...": "full call fields", "ra_name": "...", "purchased_at": "..." } ] }
```

---

#### `GET /api/me/calls/:id/comments`

Comments on a purchased call, oldest first.

**Response** `200`
```json
{ "comments": [ { "id": "...", "body": "...", "created_at": "..." } ] }
```

**Errors**
- `403` `{ "error": "Purchase required" }`

---

## Error handling

- Unmatched routes return `404` with `{ "error": "Not found" }`.
- Unexpected server/database errors return `500` with `{ "error": "Internal server error" }` (details are logged server-side, not exposed to the client).
- Endpoints that look up a single instrument (`/api/quote`, `/api/history`) return `404` with a descriptive message when nothing matches.
- `/api/auth/*` and `/api/ra/*` follow the same status-code conventions but shape errors as `{ "detail": "..." }` — see [Authentication](#authentication) and [Research Analyst Dashboard and Paid Calls](#research-analyst-dashboard-and-paid-calls).
- `/api/calls/*`, `/api/payments/*`, and `/api/me/*` shape errors as `{ "error": "..." }`, matching the market-route convention.

## Security notes

- All queries are parameterized — no raw string interpolation into SQL.
- Market-data routes (`/api/*`, excluding `/api/auth/*`) only ever run `SELECT` statements; they have no write path.
- `/api/auth/*` writes only to `users`; `/api/ra/*` writes only to `research_analysts`, `research_calls`, and `call_comments`; `/api/payments/*` and the webhook write only to `payments` and `purchased_calls` (via `completePurchase` in `src/services/purchaseService.ts`) — all via parameterized queries, each scoped to its own table(s).
- Session tokens are JWTs signed with `JWT_SECRET` (consumer users) or `RA_JWT_SECRET` (Research Analysts) — two independent secrets, so a token issued for one identity can never authenticate as the other. Treat both as secrets and rotate them (which invalidates all sessions for that identity) if ever exposed.
- Razorpay payment completion (`completePurchase`) only runs after a checkout signature (`/api/payments/verify`) or webhook signature (`/api/payments/webhook`, verified against `RAZORPAY_WEBHOOK_SECRET`) has been cryptographically verified, and is idempotent on `razorpay_order_id` — safe to run twice for the same order (e.g. once from the client, once from the webhook).
- MSG91 access-token verification proves the token is valid to MSG91, not which phone number it belongs to — `phone_number` is otherwise trusted from the request body since only `sodhani-web`'s own frontend constructs these requests. This is an accepted trust boundary given the current deployment model, not an oversight.
- The app binds to `127.0.0.1` only. The only way to reach it externally is through nginx on port 80, which is the only inbound port (besides 22/443) opened on the Azure NSG.
