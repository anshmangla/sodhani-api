# sodhani-api

A small REST API over the PostgreSQL database that [`sodhaniScrap`](https://github.com/Raman-pro/sodhaniScrap) populates. Market-data endpoints (`/api/*`) are read-only — they just query the tables `sodhaniScrap` keeps in sync and serve them as JSON: top gainers/losers, volume shockers, price/volume quotes, historical OHLCV data, and BSE announcements. Authentication endpoints (`/api/auth/*`) are the exception: they own a `users` table in the same database and are the app's only write path (see [Authentication](#authentication) below).

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
│   ├── jwt.ts            # signAuthToken / verifyAuthToken (session JWTs)
│   ├── msg91.ts          # verifyMsg91AccessToken (phone OTP verification)
│   ├── google.ts         # verifyGoogleIdToken (Google ID token verification)
│   └── middleware.ts     # requireAuth Express middleware
└── routes/
    ├── market.ts         # all /api/* market-data route handlers (read-only)
    └── auth.ts           # all /api/auth/* route handlers (reads + writes users)
db/
└── migrations/
    └── 0001_create_users.sql  # creates the users table
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

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, MSG91_AUTH_KEY, GOOGLE_CLIENT_ID
psql "$DATABASE_URL" -f db/migrations/0001_create_users.sql   # creates the users table
npm run dev             # runs src/index.ts directly via ts-node
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

Latest snapshot (price, traded volume/value, transaction count) for one instrument in the tracked watchlist (`company_stock`).

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
  "ISIN": "INE714B01016",
  "SctySrs": "...",
  "Sgmt": "...",
  "LastPric": "...",
  "TtlTradgVol": "...",
  "TtlTrfVal": "...",
  "TtlNbOfTxsExctd": "...",
  "TradDt": "2026-07-22",
  "BizDt": "2026-07-22"
}
```

**404** if the symbol/scrip code isn't in the tracked watchlist:
```json
{ "error": "No quote found for symbol 'FOO'" }
```

---

### `GET /api/history/:symbol`

Daily OHLCV history for one instrument, newest first. Same `:symbol` matching rules as `/api/quote`.

| Query param | Default | Max |
|---|---|---|
| `limit` | 30 | 1000 |

**Example**
```
GET /api/history/500012?limit=90
```

**Response**
```json
{
  "symbol": "500012",
  "count": 90,
  "history": [
    {
      "record_date": "2026-07-31",
      "open_price": "...",
      "high_price": "...",
      "low_price": "...",
      "close_price": "...",
      "adj_close": ...,
      "volume": "...",
      "dividends": "0.0000",
      "stock_splits": "0.0000"
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

## Error handling

- Unmatched routes return `404` with `{ "error": "Not found" }`.
- Unexpected server/database errors return `500` with `{ "error": "Internal server error" }` (details are logged server-side, not exposed to the client).
- Endpoints that look up a single instrument (`/api/quote`, `/api/history`) return `404` with a descriptive message when nothing matches.
- Auth endpoints follow the same status-code conventions but shape errors as `{ "detail": "..." }` — see [Authentication](#authentication).

## Security notes

- All queries are parameterized — no raw string interpolation into SQL.
- Market-data routes (`/api/*`, excluding `/api/auth/*`) only ever run `SELECT` statements; they have no write path.
- Auth routes (`/api/auth/*`) are the app's only write path — they insert/update rows in `users` only, via parameterized queries.
- Session tokens are JWTs signed with `JWT_SECRET`; treat that value as a secret and rotate it (which invalidates all sessions) if it's ever exposed.
- MSG91 access-token verification proves the token is valid to MSG91, not which phone number it belongs to — `phone_number` is otherwise trusted from the request body since only `sodhani-web`'s own frontend constructs these requests. This is an accepted trust boundary given the current deployment model, not an oversight.
- The app binds to `127.0.0.1` only. The only way to reach it externally is through nginx on port 80, which is the only inbound port (besides 22/443) opened on the Azure NSG.
