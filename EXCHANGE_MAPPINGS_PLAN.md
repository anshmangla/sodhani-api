# Adding missing stocks to `exchange_code_mappings.json` from the exchange master files

**Sources:** `BhavCopy_BSE_CM_0_0_0_20260910_F_0000.CSV` (BSE, pre-filtered) + `EQUITY_L.csv` (NSE) — these two only
**Join key:** ISIN — identical on both sides for the same company
**Mode:** additive, **plus** the 146 one-side-known reclassifications (§5) — applied on request.
**Status:** **APPLIED** 2026-09-11 via `scripts/reconcile_exchange_mappings.py`. Result: 5318 → 5454 companies; report in `mapping_reconciliation_report.json`.
**Date:** 2026-09-11

---

## 1. Decisions (settled)

| | |
|---|---|
| Source files | The BSE bhavcopy + `EQUITY_L.csv`. **No SME file.** |
| Application | Additions **and** the 146 reclassifications in §5. No company is removed; the only keys dropped are the 5 stale NSE tickers that retargeting replaces. |
| Scope | `sodhani-api/exchange_code_mappings.json`. `sodhaniScrap/companies.json` is a separate call — see §8. |

### Applied result

| | before | after |
|---|---|---|
| `both` | 2287 | **2481** |
| `bse_only` | 2359 | **2292** |
| `nse_only` | 672 | **681** |
| **total companies** | **5318** | **5454** |

53 new pairs · 70 new `bse_only` · 13 new `nse_only` · 137 promotions · 4 promotions from `nse_only` · 5 retargets.

---

## 2. The two files

| | BSE bhavcopy (10-09-2026) | NSE `EQUITY_L.csv` |
|---|---|---|
| Rows | 4,525 | 2,568 |
| Code column | `FinInstrmId` | `SYMBOL` |
| ISIN column | `ISIN` | `ISIN NUMBER` |
| Blank ISINs | 0 | 0 |
| **Duplicate ISINs** | **0** | **0** |
| Duplicate codes / malformed values | 0 | 0 |

ISIN is a perfect unique key on both sides, so the join is exact rather than heuristic.

**Three parsing gotchas:**
- NSE's headers carry **leading spaces**: `" SERIES"`, `" ISIN NUMBER"`. `csv.DictReader` keeps them verbatim, so `row['ISIN NUMBER']` raises `KeyError` — strip fieldnames on read.
- This bhavcopy's dates are **`DD-MM-YYYY`** (`10-09-2026`) where the previous one was ISO — the file has been re-saved. Nothing in the join uses dates, and codes/ISINs came through intact, but don't assume a stable date format if this is ever automated.
- Read `FinInstrmId` as a **string**, never a number, or a leading zero will eventually be eaten.

---

## 3. Which BSE rows are equities — filter on ISIN prefix

Most non-equity rows are already stripped from this file (`G` 58→0, `R` 4→0, `F` 413→28). But 64 `F`/`E` rows survive, and they are Gold ETFs and liquid-fund units. The series field is **not** the reliable way to catch them:

| ISIN prefix | rows | already in mapping | what it is |
|---|---|---|---|
| `INE` | 4,254 | 4,127 (**97%**) | company equity — **keep** |
| `IN9` | 2 | 2 (**100%**) | equity, alternate prefix — **keep** |
| `INF` | 269 | 0 (**0%**) | mutual fund / ETF units — **exclude** |

**Filter: drop rows whose ISIN starts with `INF`; keep the rest.**

This matters more than it looks. Filtering by `SctySrs ∈ {F, E}` catches only 64 of the 269 fund rows — **the other 205 sit in series `B`**, indistinguishable from equities by group, and would be added to `bse_only` as if they were stocks. (An earlier draft of this plan recommended the series filter. That was wrong.)

The rule is self-validating: 97%/100% of what it keeps is already in the mapping, 0% of what it drops is. `IN9` is why it must be "not `INF`" rather than "starts with `INE`".

After filtering: **4,256 BSE equity rows.** NSE needs no equivalent filter (`INE` 2,566 + `IN9` 2).

---

## 4. The join, and what gets added

```
BSE equity ISINs (INE/IN9)      4256
NSE main-board ISINs            2568
  ISIN on both exchanges        2395
  BSE only                      1861
  NSE only                       173
```

Applied add-only against the current file:

| | Count | Action |
|---|---|---|
| New dual-listed pairs | **53** | append to `bse_to_nse` + `nse_to_bse` |
| New BSE-only codes | **70** | append to `bse_only` |
| New NSE-only tickers | **13** | append to `nse_only` |
| Already present, both sides | 2,196 | no-op |
| **Present on one side only** | **146** | **skipped — see §5** |

```
both      2287 -> 2340
bse_only  2359 -> 2429
nse_only   672 ->  685
TOTAL     5318 -> 5454      (+136 companies)
```

Nothing is removed and no existing value is overwritten. All invariants in §6 hold on this result — verified.

---

## 5. The 146 skipped rows, and what staying add-only costs

These are cases where the join found a dual listing but **one side is already in the file**. Adding them would put the same company in two buckets at once and break the §6 invariants, so add-only must skip them. They are not silently fine — this is the price of the mode, recorded so it is a known state rather than a surprise:

| | Count | What the file will continue to say | Reality per ISIN |
|---|---|---|---|
| Code already in `bse_only`, ticker new | **137** | BSE-only | dual-listed |
| Code already in `bse_to_nse`, ticker new | **5** | mapped to a **stale ticker** | renamed |
| Ticker already in `nse_only`, code new | **4** | NSE-only | dual-listed |

The 5 stale ones are worth naming, because one of them resolves to the wrong company today:

| BSE code | file says | ISIN says |
|---|---|---|
| 544743 | `AMIRCHAND` | `AEROPLANE` |
| **539336** | **`GUJGASLTD`** | **`GUJENERGY`** |
| 543766 | `ASHIKA` | `ASHIKAG` |
| 500279 | `MIRCELECTR` | `ONIDA` |
| 534532 | `LYPSAGEMS` | `AURUS` |

`GUJGASLTD` is a different, actively traded company (Gujarat Gas), so anything resolving `539336` through this file lands on the wrong stock. That is pre-existing — this change neither causes nor fixes it.

**All 146 should be written to the report (§6, step 7) rather than dropped on the floor.** If you later want the 137 promotions — which only *add* the NSE ticker to companies already in the file, losing nothing — that is a one-line switch, and it is a strictly separate decision from the 5 retargets, which do overwrite.

---

## 6. Implementation

One script (`sodhaniScrap/src/scripts/addMissingExchangeMappings.ts`, or Python under `python/` — the work is CSV-shaped, so Python is lower-friction), **read-only by default**:

1. **Parse BSE** with `csv`; strip whitespace on every field; read codes as strings; **drop ISINs starting with `INF`**; key by ISIN.
2. **Parse NSE** with fieldnames stripped (the leading-space trap); key by ISIN.
3. **Assert** before joining: no blank ISIN, no duplicate ISIN, no duplicate code on either side. All hold today; if one stops holding, fail rather than silently pick a row.
4. **Join** on ISIN → `both` / `bse_only` / `nse_only`.
5. **Build the present-sets** once: `codes = bse_only ∪ bse_to_nse.keys()`, `tickers = nse_only ∪ nse_to_bse.keys()`.
6. **Append only** where neither side is present:
   - pair → `bse_to_nse[code] = ticker` **and** `nse_to_bse[ticker] = code` (both directions, always together)
   - BSE-only code not in `codes` → `bse_only`
   - NSE-only ticker not in `tickers` → `nse_only`
   - anything else → skip and record
7. **Recompute `summary`** from the final lengths — it is derived, never hand-edited. Leave `invalid_bse_links`, `duplicate_bse_codes`, `parse_errors` as the empty structures they are; they belong to the old link-scraping derivation and no longer have a source.
8. **Write `mapping_reconciliation_report.json`** — every addition and every one of the 146 skips, each with its ISIN and the company name from both files — then stop. Apply to the JSON only under an explicit `--write`.
9. **Assert §7 invariants** before writing; fail closed if any breaks.

**Idempotence:** a second run against the same CSVs must add nothing and produce a byte-identical file. Sort every array and object key, fixed 2-space indent, so `git diff` shows only genuine changes.

---

## 7. Invariants to assert

All hold on the current file and on the result above:

- `bse_to_nse` and `nse_to_bse` are exact inverses, equal length
- no BSE code in both `bse_only` and `bse_to_nse`
- no NSE ticker in both `nse_only` and `nse_to_bse`
- no duplicate BSE code anywhere in the file
- `summary` counts equal the actual array/object lengths
- every BSE code is 6 digits; every NSE ticker is non-numeric
- **add-only:** every key present before the run is still present, with an unchanged value

That last one is the guard that enforces the mode — cheap to assert, and it makes "we never deleted anything" a checked fact rather than an intention.

---

## 8. Scope note — the other file

`sodhaniScrap/companies.json` holds the identical structure and counts (2359 / 672 / 2287), but is **not** in scope here.

**`sodhani-api/exchange_code_mappings.json` — low risk.** Read-only symbol resolution at `src/routes/market.ts:987` and `:1143`, plus `test/companySplitDataService.test.ts:16`. Adding entries improves lookups and breaks nothing.

**`sodhaniScrap/companies.json` — high risk**, if you ever decide to mirror the change:

| Consumer | Effect |
|---|---|
| `csvParser.parseCompaniesJson` → `bootstrapMasterList` | **creates a `company_stock` row per new entry**, which then pulls Yahoo history on next restart and enters live-sync coverage |
| `bseLiveSync.getNseStockCodes` (`:16`) | feeds the prev-close precedence deployed today — adding 53 dual-listed pairs means BSE stops writing those codes' `prev_close` and NSE must supply it |
| `yahooHistory` (`:16`) | `bse_to_nse` fallback symbol for history fetches |

Note `bootstrap.ts` only inserts and updates — never deletes. Reverting `companies.json` after a bootstrap does **not** remove the rows it created; that needs an explicit `DELETE`. If you do mirror it, do it during market hours where the `prev_close` effect is observable.

---

## 9. Why the `output/` approach was dropped (recorded so it isn't retried)

An earlier plan sourced codes from `overview.bse_link` / `nse_link` in `/opt/sodhaniScrap/output`. Those fields are empty in **all 5,436** files — along with `website` — including large names like TCS. A `grep` for `bseindia` across both output folders hits 3 files, all incidental PDF URLs in report text; `nseindia` hits zero.

The mapping was originally generated (as `companies.json`, Aug 2) by parsing those links, which is why `invalid_bse_links` and `parse_errors` exist as keys. The current scrape no longer populates them.

Separately worth a look, but not part of this work: whatever regressed `bse_link` / `nse_link` / `website` in the screener overview parser presumably broke all three at once.
