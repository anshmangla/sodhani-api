#!/usr/bin/env python3
"""Reconcile exchange_code_mappings.json against the exchange master files.

Sources (repo root):
  BhavCopy_BSE_CM_*.CSV  - BSE bhavcopy: FinInstrmId (scrip code), ISIN, SctySrs
  EQUITY_L.csv           - NSE main board: SYMBOL, ISIN NUMBER

The two files are joined on ISIN, which is identical across exchanges for the
same company and is a unique, non-blank key in both (asserted below). That makes
the dual-listing determination exact rather than a ticker-string guess.

Read-only by default: prints the plan and writes a report. Pass --write to apply.

    python scripts/reconcile_exchange_mappings.py            # report only
    python scripts/reconcile_exchange_mappings.py --write    # apply
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
import collections
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPING = os.path.join(ROOT, "exchange_code_mappings.json")
NSE_CSV = os.path.join(ROOT, "EQUITY_L.csv")
SUPPLEMENT = os.path.join(ROOT, "bse_isin_supplement.json")
REPORT = os.path.join(ROOT, "mapping_reconciliation_report.json")

# NSE publishes SME (Emerge) listings in their own file, with underscored
# headers rather than the main board's leading-space ones. Optional: pass
# --sme-csv to include them. Their ISINs do not appear in the BSE equity
# bhavcopy, so every SME row resolves to nse_only.
SME_SYMBOL_KEYS = ("SYMBOL",)
SME_ISIN_KEYS = ("ISIN_NUMBER", "ISIN NUMBER")

# What counts as a company equity, decided from the ISIN rather than from the
# exchange's own series/group field.
#
# An Indian ISIN is IN + issuer-type + 5-char issuer + 2-char security type + a
# check digit. The issuer-type is E for companies, F for mutual funds, 0 for
# government paper, and 9 for partly-paid or differential-voting-rights lines -
# a second listing of a company that already appears under its ordinary code,
# so including those duplicates the company (890217 Aplab alongside 517096
# Aplab, and four more). The security type is "01" for ordinary equity, "07"/"08"
# for debentures and bonds, "20" for a Rights Entitlement (a temporary
# instrument that trades only while a rights issue is open, then ceases to
# exist). "23" and "25" are further equity classes this mapping has always
# carried.
#
# Both halves are needed. Filtering on SctySrs alone lets 205 fund rows through
# in series B; filtering on the INE prefix alone lets through 338 debentures and
# 28 bonds, which are issued by companies and so carry INE ISINs too. Measured
# against the existing mapping on a full bhavcopy, this rule keeps what is
# already there (01: 100%, 23: 100%, 25: 100%) and drops what is not (07, 08,
# A7, 09, 24, 20 and every INF/IN0/IN4 row: 0%). IN9 lines already in the file
# stay there - nothing is ever removed - they simply are not re-asserted.
EQUITY_ISIN_PREFIXES = ("INE",)
EQUITY_SECURITY_TYPES = {"01", "23", "25"}
RIGHTS_ENTITLEMENT_TYPE = "20"


def is_equity_isin(isin: str) -> bool:
    return (len(isin) == 12
            and isin[:3] in EQUITY_ISIN_PREFIXES
            and isin[7:9] in EQUITY_SECURITY_TYPES)


def is_rights_entitlement(isin: str) -> bool:
    return len(isin) == 12 and isin[7:9] == RIGHTS_ENTITLEMENT_TYPE


BSE_CODE_RE = re.compile(r"^\d{6}$")
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}\d$")


def find_bhavcopy(directory: str) -> str:
    matches = sorted(glob.glob(os.path.join(directory, "BhavCopy_BSE_CM_*.CSV")))
    if not matches:
        sys.exit(f"No BhavCopy_BSE_CM_*.CSV found in {directory}.")
    if len(matches) > 1:
        # Deliberate: silently picking one would make the run non-reproducible.
        sys.exit(
            "Multiple bhavcopy files found; keep exactly one:\n  "
            + "\n  ".join(os.path.basename(m) for m in matches)
        )
    return matches[0]


def read_csv_stripped(path: str) -> list[dict]:
    """NSE's headers carry leading spaces (' ISIN NUMBER'), so strip fieldnames."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        reader.fieldnames = [(f or "").strip() for f in (reader.fieldnames or [])]
        return [{k: (v or "").strip() for k, v in row.items() if k} for row in reader]


def check_unique(rows: list[dict], isin_key: str, code_key: str, label: str) -> None:
    """Fail loudly rather than silently picking a row if the key stops being unique."""
    isins = [r[isin_key] for r in rows]
    codes = [r[code_key] for r in rows]
    problems = []
    if blank := sum(1 for i in isins if not i):
        problems.append(f"{blank} blank ISIN(s)")
    if dups := [k for k, v in Counter(isins).items() if v > 1]:
        problems.append(f"{len(dups)} duplicated ISIN(s), e.g. {dups[:5]}")
    if dupc := [k for k, v in Counter(codes).items() if v > 1]:
        problems.append(f"{len(dupc)} duplicated code(s), e.g. {dupc[:5]}")
    if bad := [i for i in isins if i and not ISIN_RE.match(i)]:
        problems.append(f"{len(bad)} malformed ISIN(s), e.g. {bad[:5]}")
    if problems:
        sys.exit(f"{label}: " + "; ".join(problems))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="apply changes to the mapping file")
    ap.add_argument("--bhavcopy", help="BSE bhavcopy CSV (default: the one in the repo root)")
    ap.add_argument("--nse-csv", default=NSE_CSV, help="NSE EQUITY_L.csv")
    ap.add_argument("--sme-csv", help="NSE SME_EQUITY_L.csv (optional; adds Emerge listings)")
    ap.add_argument("--mapping", default=MAPPING, help="mapping JSON to update")
    ap.add_argument("--mirror", action="append", default=[],
                    help="extra path to write the same JSON to (repeatable), e.g. companies.json")
    ap.add_argument("--supplement", default=SUPPLEMENT, help="ISIN -> BSE code supplement JSON")
    ap.add_argument("--report", default=REPORT, help="where to write the run report")
    ap.add_argument("--quiet", action="store_true", help="only print when something changed")
    args = ap.parse_args()

    mapping_path, supplement_path, report_path = args.mapping, args.supplement, args.report
    bhavcopy = args.bhavcopy or find_bhavcopy(ROOT)
    bse_rows = read_csv_stripped(bhavcopy)
    nse_rows = read_csv_stripped(args.nse_csv)

    # SME rows are normalised onto the main-board field names so the join below
    # does not need to care which file a listing came from.
    sme_rows = []
    if args.sme_csv:
        for r in read_csv_stripped(args.sme_csv):
            sym = next((r[k] for k in SME_SYMBOL_KEYS if r.get(k)), "")
            isin = next((r[k] for k in SME_ISIN_KEYS if r.get(k)), "")
            if sym and isin:
                sme_rows.append({"SYMBOL": sym, "ISIN NUMBER": isin,
                                 "NAME OF COMPANY": r.get("NAME_OF_COMPANY", "")})
        seen_isin = {r["ISIN NUMBER"] for r in nse_rows}
        seen_sym = {r["SYMBOL"] for r in nse_rows}
        # A symbol that graduated from Emerge to the main board appears in both;
        # the main board entry wins.
        sme_rows = [r for r in sme_rows
                    if r["ISIN NUMBER"] not in seen_isin and r["SYMBOL"] not in seen_sym]
        nse_rows = nse_rows + sme_rows

    rejected = collections.Counter()
    rights = []
    for row, key, ident in ([(r, "ISIN", "FinInstrmId") for r in bse_rows]
                            + [(r, "ISIN NUMBER", "SYMBOL") for r in nse_rows]):
        isin = row[key]
        if not is_equity_isin(isin):
            rejected[isin[:3] + "/" + (isin[7:9] if len(isin) == 12 else "??")] += 1
            if is_rights_entitlement(isin):
                rights.append(row[ident])
    nse_rows = [r for r in nse_rows if is_equity_isin(r["ISIN NUMBER"])]
    non_equity = len(bse_rows)
    bse_rows = [r for r in bse_rows if is_equity_isin(r["ISIN"])]
    non_equity -= len(bse_rows)

    check_unique(bse_rows, "ISIN", "FinInstrmId", "BSE bhavcopy")
    check_unique(nse_rows, "ISIN NUMBER", "SYMBOL", "NSE equity list")

    if bad := [r["FinInstrmId"] for r in bse_rows if not BSE_CODE_RE.match(r["FinInstrmId"])]:
        sys.exit(f"BSE bhavcopy: {len(bad)} non-6-digit code(s), e.g. {bad[:5]}")

    bse_by_isin = {r["ISIN"]: r for r in bse_rows}
    nse_by_isin = {r["ISIN NUMBER"]: r for r in nse_rows}

    # A bhavcopy only lists scrips that traded that day, so an illiquid scrip is
    # absent and the join cannot see its BSE side - leaving the NSE ticker to be
    # filed as nse_only while its BSE code sits in bse_only, i.e. one company
    # recorded twice. The supplement carries ISIN -> code for those, so they pair
    # normally. Entries already covered by the bhavcopy are ignored.
    supplemented = []
    if os.path.exists(supplement_path):
        with open(supplement_path, encoding="utf-8") as fh:
            supp = {k: v for k, v in json.load(fh).items() if not k.startswith("_")}
        known_bse_codes = {r["FinInstrmId"] for r in bse_rows}
        for isin, code in sorted(supp.items()):
            if not ISIN_RE.match(isin) or not BSE_CODE_RE.match(code):
                sys.exit(f"bse_isin_supplement.json: malformed entry {isin} -> {code}")
            if isin in bse_by_isin or code in known_bse_codes:
                continue  # the bhavcopy already covers it; never override the exchange file
            bse_by_isin[isin] = {"FinInstrmId": code, "ISIN": isin, "FinInstrmNm": ""}
            known_bse_codes.add(code)
            supplemented.append({"isin": isin, "bse_code": code})
    names = {r["ISIN"]: r["FinInstrmNm"] for r in bse_rows}
    names.update({r["ISIN NUMBER"]: r["NAME OF COMPANY"] for r in nse_rows})

    shared = set(bse_by_isin) & set(nse_by_isin)
    pairs = {bse_by_isin[i]["FinInstrmId"]: (nse_by_isin[i]["SYMBOL"], i) for i in shared}
    bse_only_join = {bse_by_isin[i]["FinInstrmId"]: i for i in set(bse_by_isin) - set(nse_by_isin)}
    nse_only_join = {nse_by_isin[i]["SYMBOL"]: i for i in set(nse_by_isin) - set(bse_by_isin)}

    with open(mapping_path, encoding="utf-8") as fh:
        m = json.load(fh)
    before = json.dumps(m, sort_keys=True)

    b2n: dict[str, str] = dict(m["bse_to_nse"])
    bse_only: set[str] = set(m["bse_only"])
    nse_only: set[str] = set(m["nse_only"])
    known_codes = bse_only | set(b2n)
    known_ticks = nse_only | set(m["nse_to_bse"])

    ops: dict[str, list] = {
        "new_pair": [], "new_bse_only": [], "new_nse_only": [],
        "promote_from_bse_only": [], "promote_from_nse_only": [], "retarget": [],
    }

    for code, (ticker, isin) in sorted(pairs.items()):
        entry = {"bse_code": code, "nse_ticker": ticker, "isin": isin,
                 "company": names.get(isin, "")}
        if code in b2n and b2n[code] != ticker:
            ops["retarget"].append({**entry, "was": b2n[code]})
        elif code in bse_only:
            ops["promote_from_bse_only"].append(entry)
        elif ticker in nse_only:
            ops["promote_from_nse_only"].append(entry)
        elif code not in known_codes and ticker not in known_ticks:
            ops["new_pair"].append(entry)
        else:
            continue  # already recorded correctly
        # A company lives in exactly one bucket: drop it from the single-exchange
        # sets before writing the pair, or it would be counted twice.
        bse_only.discard(code)
        nse_only.discard(ticker)
        b2n[code] = ticker

    for code, isin in sorted(bse_only_join.items()):
        # Only add codes nothing knows about. A code already in bse_to_nse stays
        # there: absence from today's NSE main-board file is not proof of
        # delisting (it may be SME-listed), so we never demote.
        if code not in known_codes:
            bse_only.add(code)
            ops["new_bse_only"].append({"bse_code": code, "isin": isin,
                                        "company": names.get(isin, "")})

    for ticker, isin in sorted(nse_only_join.items()):
        if ticker not in known_ticks and ticker not in set(b2n.values()):
            nse_only.add(ticker)
            ops["new_nse_only"].append({"nse_ticker": ticker, "isin": isin,
                                        "company": names.get(isin, "")})

    n2b = {t: c for c, t in b2n.items()}
    dropped_ticks = sorted(set(m["nse_to_bse"]) - set(n2b))

    m["bse_only"] = sorted(bse_only)
    m["nse_only"] = sorted(nse_only)
    m["bse_to_nse"] = dict(sorted(b2n.items()))
    m["nse_to_bse"] = dict(sorted(n2b.items()))
    m["summary"] = {
        "bse_only_count": len(bse_only),
        "nse_only_count": len(nse_only),
        "both_count": len(b2n),
        "parse_error_count": len(m.get("parse_errors", [])),
        "invalid_bse_link_count": len(m.get("invalid_bse_links", [])),
        "duplicate_bse_code_count": len(m.get("duplicate_bse_codes", {})),
    }

    # ---- invariants -------------------------------------------------------
    errors = []
    if len(b2n) != len(n2b):
        errors.append(f"bse_to_nse ({len(b2n)}) and nse_to_bse ({len(n2b)}) differ in length")
    if any(n2b.get(t) != c for c, t in b2n.items()):
        errors.append("bse_to_nse and nse_to_bse are not exact inverses")
    if overlap := bse_only & set(b2n):
        errors.append(f"{len(overlap)} code(s) in both bse_only and bse_to_nse: {sorted(overlap)[:5]}")
    if overlap := nse_only & set(n2b):
        errors.append(f"{len(overlap)} ticker(s) in both nse_only and nse_to_bse: {sorted(overlap)[:5]}")
    if bad := [c for c in bse_only | set(b2n) if not BSE_CODE_RE.match(c)]:
        errors.append(f"{len(bad)} malformed BSE code(s): {bad[:5]}")
    if bad := [t for t in nse_only | set(n2b) if t.isdigit()]:
        errors.append(f"{len(bad)} numeric NSE ticker(s): {bad[:5]}")
    for key, count in (("bse_only", "bse_only_count"), ("nse_only", "nse_only_count")):
        if len(m[key]) != m["summary"][count]:
            errors.append(f"summary.{count} does not match len({key})")

    # No company may be lost. Every identity known before must still be present,
    # except the stale tickers that retargeting deliberately replaces.
    kept_codes = bse_only | set(b2n)
    kept_ticks = nse_only | set(n2b)
    if lost := sorted(known_codes - kept_codes):
        errors.append(f"{len(lost)} BSE code(s) disappeared: {lost[:5]}")
    if lost := sorted(known_ticks - kept_ticks - set(dropped_ticks)):
        errors.append(f"{len(lost)} NSE ticker(s) disappeared unexpectedly: {lost[:5]}")

    # ---- report -----------------------------------------------------------
    report = {
        "sources": {
            "bse_bhavcopy": os.path.basename(bhavcopy),
            "nse_equity_list": os.path.basename(args.nse_csv),
            "nse_sme_list": os.path.basename(args.sme_csv) if args.sme_csv else None,
            "nse_sme_rows_added": len(sme_rows),
            "rights_entitlements_excluded": sorted(rights),
            "bse_equity_rows": len(bse_rows),
            "bse_non_equity_rows_excluded": non_equity,
            "excluded_by_isin_prefix_and_type": dict(rejected.most_common()),
            "bse_codes_from_supplement": len(supplemented),
            "nse_rows": len(nse_rows),
        },
        "join": {"both": len(pairs), "bse_only": len(bse_only_join), "nse_only": len(nse_only_join)},
        "counts": {k: len(v) for k, v in ops.items()},
        "totals": {
            "before": {"both": len(m["nse_to_bse"]) - len(ops["new_pair"])
                       - len(ops["promote_from_bse_only"]) - len(ops["promote_from_nse_only"]),
                       "bse_only": len(json.loads(before)["bse_only"]),
                       "nse_only": len(json.loads(before)["nse_only"])},
            "after": {"both": len(b2n), "bse_only": len(bse_only), "nse_only": len(nse_only)},
        },
        "supplemented_bse_codes": supplemented,
        "stale_nse_tickers_removed": dropped_ticks,
        "operations": ops,
        "invariant_errors": errors,
    }
    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    old = json.loads(before)
    changed = sum(len(v) for v in ops.values()) > 0
    if args.quiet and not changed and not errors:
        return

    print(f"BSE {os.path.basename(bhavcopy)}: {len(bse_rows)} equity rows "
          f"({non_equity} non-equity rows excluded"
          + (f", +{len(supplemented)} from supplement" if supplemented else "") + ")")
    print(f"NSE {os.path.basename(args.nse_csv)}: {len(nse_rows)} rows"
          + (f" (+{len(sme_rows)} SME)" if sme_rows else ""))
    if rights:
        print(f"  excluded {len(rights)} rights entitlement(s): {', '.join(sorted(rights))}")
    print(f"join: both {len(pairs)} | bse_only {len(bse_only_join)} | nse_only {len(nse_only_join)}\n")
    for k in ("new_pair", "new_bse_only", "new_nse_only",
              "promote_from_bse_only", "promote_from_nse_only", "retarget"):
        print(f"  {k:24} {len(ops[k]):5}")
    print(f"\n  both      {len(old['bse_to_nse']):5} -> {len(b2n)}")
    print(f"  bse_only  {len(old['bse_only']):5} -> {len(bse_only)}")
    print(f"  nse_only  {len(old['nse_only']):5} -> {len(nse_only)}")
    print(f"  TOTAL     {len(old['bse_to_nse']) + len(old['bse_only']) + len(old['nse_only']):5}"
          f" -> {len(b2n) + len(bse_only) + len(nse_only)}")
    if dropped_ticks:
        print(f"\n  stale NSE tickers removed by retargeting ({len(dropped_ticks)}): "
              + ", ".join(dropped_ticks))
    print(f"\nreport: {os.path.relpath(REPORT, ROOT)}")

    if errors:
        print("\nINVARIANT FAILURES:")
        for e in errors:
            print("  -", e)
        sys.exit("refusing to write")

    if not args.write:
        print("\nDry run. Re-run with --write to apply.")
        return

    with open(MAPPING, "w", encoding="utf-8") as fh:
        json.dump(m, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"\nwrote {os.path.relpath(MAPPING, ROOT)}")


if __name__ == "__main__":
    main()
