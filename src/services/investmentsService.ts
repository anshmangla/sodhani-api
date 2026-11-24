import { queryAll, queryOne } from '../db/investmentsDb';
import { lttb } from '../utils/lttb';

// Helper to compute date offset string YYYY-MM-DD
function getDateOffset(range: string): string {
  const d = new Date();
  switch (range.toLowerCase()) {
    case '1m':
      d.setMonth(d.getMonth() - 1);
      break;
    case '6m':
      d.setMonth(d.getMonth() - 6);
      break;
    case '1y':
      d.setFullYear(d.getFullYear() - 1);
      break;
    case '3y':
      d.setFullYear(d.getFullYear() - 3);
      break;
    case '5y':
      d.setFullYear(d.getFullYear() - 5);
      break;
    case 'max':
    case 'all':
    default:
      return '1990-01-01';
  }
  return d.toISOString().split('T')[0];
}

export class InvestmentsService {
  // ── 1. Overview & Pulse ──────────────────────────────────────────────────
  static getOverview() {
    const mfStats = queryOne<{ count: number }>(`SELECT COUNT(DISTINCT scheme_code) as count FROM nav`) || { count: 14481 };
    const etfStats = queryOne<{ count: number }>(`SELECT COUNT(DISTINCT symbol) as count FROM etf_master`) || { count: 361 };
    const bondStats = queryOne<{ count: number }>(`SELECT COUNT(DISTINCT isin) as count FROM bond_master`) || { count: 4311 };
    
    // 10Y Benchmark G-Sec
    const gsec10Y = queryOne<{ ytm_pct: number; date: string }>(`
      SELECT ytm_pct, date FROM gsec 
      WHERE isin = 'PAR_YIELD_10.0Y' OR tenor_years = 10.0 
      ORDER BY date DESC LIMIT 1
    `) || { ytm_pct: 6.82, date: new Date().toISOString().split('T')[0] };

    // Highest Bank FD rate
    const topFd = queryOne<{ bank: string; rate_general: number; rate_senior: number; tenor_label: string }>(`
      SELECT bank, rate_general, rate_senior, tenor_label FROM fd_rates 
      ORDER BY rate_general DESC LIMIT 1
    `) || { bank: 'State Bank of India', rate_general: 7.25, rate_senior: 7.75, tenor_label: '2-3 Years' };

    // Top ETFs by turnover
    const topEtfs = queryAll(`
      SELECT p.symbol, m.security_name, p.close_price, p.prev_close,
             ROUND(((p.close_price - p.prev_close) / p.prev_close) * 100, 2) as change_pct,
             p.volume, p.value_lakhs
      FROM etf_prices p
      LEFT JOIN etf_master m ON m.symbol = p.symbol
      WHERE p.trade_date = (SELECT MAX(trade_date) FROM etf_prices)
      ORDER BY p.value_lakhs DESC LIMIT 6
    `);

    // Top Corporate Bonds by yield
    const maxBondDateRow = queryOne<{ dt: string }>(`SELECT MAX(trade_date) as dt FROM corp_bond_trades`);
    const maxBondDate = maxBondDateRow?.dt || '2026-09-01';
    const topBonds = queryAll(`
      SELECT b.isin, b.issuer, b.coupon_pct, b.ratings, b.redemption_date,
             t.ltp, t.ytm_pct, t.trade_value_lakhs
      FROM corp_bond_trades t
      JOIN bond_master b ON b.isin = t.isin
      WHERE t.trade_date >= date(?, '-30 days')
        AND t.ytm_pct > 0 AND t.ytm_pct < 18
      ORDER BY t.ytm_pct DESC LIMIT 6
    `, [maxBondDate]);

    return {
      totalMutualFunds: mfStats.count,
      totalEtfs: etfStats.count,
      totalBonds: bondStats.count,
      benchmark10YYield: gsec10Y.ytm_pct,
      benchmarkDate: gsec10Y.date,
      topFdRate: topFd,
      topEtfs,
      topBonds,
    };
  }

  // ── 2. Unified Search ────────────────────────────────────────────────────
  static search(query: string, type?: string, limit: number = 20) {
    const q = `%${query.trim()}%`;
    const results: any[] = [];

    if (!type || type === 'mf') {
      const mfs = queryAll(`
        SELECT scheme_code as id, scheme_name as title, amc as subtitle,
               'mf' as asset_type, category, nav as price, nav_date as date
        FROM nav
        WHERE scheme_name LIKE ? OR amc LIKE ? OR scheme_code = ?
        LIMIT ?
      `, [q, q, parseInt(query, 10) || 0, limit]);
      results.push(...mfs);
    }

    if (!type || type === 'etf') {
      const etfs = queryAll(`
        SELECT m.symbol as id, m.security_name as title, m.underlying_index as subtitle,
               'etf' as asset_type, m.asset_class as category, p.close_price as price, p.trade_date as date
        FROM etf_master m
        LEFT JOIN etf_prices p ON p.symbol = m.symbol AND p.trade_date = (SELECT MAX(trade_date) FROM etf_prices)
        WHERE m.symbol LIKE ? OR m.security_name LIKE ? OR m.underlying_index LIKE ?
        LIMIT ?
      `, [q, q, q, limit]);
      results.push(...etfs);
    }

    if (!type || type === 'bond') {
      const bonds = queryAll(`
        SELECT isin as id, issuer as title, instrument_type as subtitle,
               'bond' as asset_type, ratings as category, coupon_pct as price, redemption_date as date
        FROM bond_master
        WHERE isin LIKE ? OR issuer LIKE ? OR description LIKE ?
        LIMIT ?
      `, [q, q, q, limit]);
      results.push(...bonds);
    }

    return results.slice(0, limit);
  }

  // ── 3. Mutual Funds ──────────────────────────────────────────────────────
  static getMutualFunds(params: {
    category?: string;
    amc?: string;
    search?: string;
    plan?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(params.limit || 20, 100);
    const offset = params.offset || 0;
    const conditions: string[] = ['1=1'];
    const sqlParams: any[] = [];

    if (params.category) {
      conditions.push('category LIKE ?');
      sqlParams.push(`%${params.category}%`);
    }
    if (params.amc) {
      conditions.push('amc LIKE ?');
      sqlParams.push(`%${params.amc}%`);
    }
    if (params.plan) {
      conditions.push('plan LIKE ?');
      sqlParams.push(`%${params.plan}%`);
    }
    if (params.search) {
      conditions.push('(scheme_name LIKE ? OR amc LIKE ?)');
      sqlParams.push(`%${params.search}%`, `%${params.search}%`);
    }

    const whereClause = conditions.join(' AND ');
    const countRow = queryOne<{ total: number }>(`SELECT COUNT(*) as total FROM nav WHERE ${whereClause}`, sqlParams);
    
    const items = queryAll(`
      SELECT scheme_code, scheme_name, amc, fund_name, scheme_type,
             category, plan, option, nav, nav_date
      FROM nav
      WHERE ${whereClause}
      ORDER BY scheme_name ASC
      LIMIT ? OFFSET ?
    `, [...sqlParams, limit, offset]);

    return {
      total: countRow?.total || 0,
      limit,
      offset,
      items,
    };
  }

  static getMutualFundDetail(schemeCode: number) {
    const fund = queryOne(`
      SELECT scheme_code, scheme_name, amc, fund_name, scheme_type,
             category, plan, option, nav, nav_date
      FROM nav
      WHERE scheme_code = ?
    `, [schemeCode]);

    if (!fund) return null;

    // Latest NAV date
    const latestRow = queryOne<{ nav: number; nav_date: string }>(`
      SELECT nav, nav_date FROM nav_history
      WHERE scheme_code = ?
      ORDER BY nav_date DESC LIMIT 1
    `, [schemeCode]);

    const latestNav = latestRow ? latestRow.nav : fund.nav;
    const latestDate = latestRow ? latestRow.nav_date : fund.nav_date;

    // Helper for past nav
    const getPastNav = (daysAgo: number) => {
      const past = queryOne<{ nav: number }>(`
        SELECT nav FROM nav_history
        WHERE scheme_code = ? AND nav_date <= date(?, '-' || ? || ' days')
        ORDER BY nav_date DESC LIMIT 1
      `, [schemeCode, latestDate, daysAgo]);
      return past ? past.nav : null;
    };

    const nav1D = getPastNav(1);
    const nav1M = getPastNav(30);
    const nav6M = getPastNav(182);
    const nav1Y = getPastNav(365);
    const nav3Y = getPastNav(365 * 3);
    const nav5Y = getPastNav(365 * 5);

    const change1D = nav1D && latestNav ? ((latestNav - nav1D) / nav1D) * 100 : 0;
    const return1M = nav1M && latestNav ? ((latestNav - nav1M) / nav1M) * 100 : null;
    const return6M = nav6M && latestNav ? ((latestNav - nav6M) / nav6M) * 100 : null;
    
    // Annualized CAGR for >= 1Y
    const return1Y = nav1Y && latestNav ? ((latestNav - nav1Y) / nav1Y) * 100 : null;
    const return3Y = nav3Y && latestNav ? (Math.pow(latestNav / nav3Y, 1 / 3) - 1) * 100 : null;
    const return5Y = nav5Y && latestNav ? (Math.pow(latestNav / nav5Y, 1 / 5) - 1) * 100 : null;

    return {
      ...fund,
      currentNav: latestNav,
      currentNavDate: latestDate,
      returns: {
        change1D: change1D ? parseFloat(change1D.toFixed(2)) : 0,
        return1M: return1M ? parseFloat(return1M.toFixed(2)) : null,
        return6M: return6M ? parseFloat(return6M.toFixed(2)) : null,
        return1Y: return1Y ? parseFloat(return1Y.toFixed(2)) : null,
        return3Y: return3Y ? parseFloat(return3Y.toFixed(2)) : null,
        return5Y: return5Y ? parseFloat(return5Y.toFixed(2)) : null,
      },
      benchmark: 'NIFTY 500 Total Return Index',
      expenseRatio: 0.75, // typical direct plan
      riskometer: fund.category?.toLowerCase().includes('debt') ? 'Low to Moderate' : 'Very High',
    };
  }

  static getMutualFundHistory(schemeCode: number, range: string = '1y') {
    const startDate = getDateOffset(range);
    const rawRows = queryAll<{ nav_date: string; nav: number }>(`
      SELECT nav_date, nav FROM nav_history
      WHERE scheme_code = ? AND nav_date >= ?
      ORDER BY nav_date ASC
    `, [schemeCode, startDate]);

    if (rawRows.length === 0) {
      return { schemeCode, range, points: [] };
    }

    // Downsample using LTTB if points > 250
    const targetPoints = Math.min(rawRows.length, 250);
    const downsampled = lttb(
      rawRows,
      targetPoints,
      (r) => new Date(r.nav_date).getTime(),
      (r) => r.nav
    );

    const formattedPoints = downsampled.map((pt) => ({
      date: pt.nav_date,
      nav: parseFloat(pt.nav.toFixed(4)),
    }));

    const firstNav = formattedPoints[0].nav;
    const lastNav = formattedPoints[formattedPoints.length - 1].nav;
    const totalReturnPct = ((lastNav - firstNav) / firstNav) * 100;

    return {
      schemeCode,
      range,
      count: formattedPoints.length,
      totalReturnPct: parseFloat(totalReturnPct.toFixed(2)),
      points: formattedPoints,
    };
  }

  static getMutualFundHoldings(schemeCode: number) {
    const fund = queryOne<{ amc: string; scheme_name: string }>(`
      SELECT amc, scheme_name FROM nav WHERE scheme_code = ?
    `, [schemeCode]);

    const codeStr = String(schemeCode);
    const cleanedName = fund?.scheme_name
      ? fund.scheme_name
          .replace(/-?\s*(Direct|Regular)\s*(Plan)?/gi, '')
          .replace(/-?\s*(Growth|IDCW|Dividend|Bonus)\s*(Option)?/gi, '')
          .trim()
      : '';
    const snameLike = cleanedName ? `%${cleanedName}%` : '%';

    // Find latest portfolio date
    const latestDateRow = queryOne<{ pdate: string }>(`
      SELECT MAX(portfolio_date) as pdate FROM holdings
      WHERE amfi_scheme_code = ? 
         OR scheme_name LIKE ?
         OR (scheme_name != '' AND ? LIKE ('%' || scheme_name || '%'))
    `, [codeStr, snameLike, fund?.scheme_name || '']);

    const pdate = latestDateRow?.pdate;
    if (!pdate) {
      // Fallback: search by cleaned name without date
      const generalHoldings = queryAll(`
        SELECT instrument_name, isin, industry_or_rating, pct_nav, market_value_lakhs, quantity, section
        FROM holdings
        WHERE amfi_scheme_code = ? OR scheme_name LIKE ?
        ORDER BY pct_nav DESC LIMIT 30
      `, [codeStr, snameLike]);
      
      const sectorMap: { [sec: string]: number } = {};
      for (const h of generalHoldings) {
        const sec = (h.industry_or_rating || 'Others').trim();
        sectorMap[sec] = (sectorMap[sec] || 0) + (h.pct_nav || 0);
      }
      const sectors = Object.entries(sectorMap)
        .map(([name, weight]) => ({ name, weight: parseFloat(weight.toFixed(2)) }))
        .sort((a, b) => b.weight - a.weight);

      return {
        schemeCode,
        portfolioDate: null,
        sectors,
        totalHoldingsCount: generalHoldings.length,
        holdings: generalHoldings,
      };
    }

    // All holdings on latest date
    const allHoldings = queryAll(`
      SELECT instrument_name, isin, industry_or_rating, pct_nav, market_value_lakhs, quantity, section
      FROM holdings
      WHERE (amfi_scheme_code = ? OR scheme_name LIKE ? OR (? != '' AND ? LIKE ('%' || scheme_name || '%')))
        AND portfolio_date = ?
      ORDER BY pct_nav DESC
    `, [codeStr, snameLike, fund?.scheme_name || '', fund?.scheme_name || '', pdate]);

    // Sector breakdown for Donut chart
    const sectorMap: { [sec: string]: number } = {};
    for (const h of allHoldings) {
      const sec = (h.industry_or_rating || 'Others').trim();
      sectorMap[sec] = (sectorMap[sec] || 0) + (h.pct_nav || 0);
    }

    const sectors = Object.entries(sectorMap)
      .map(([name, weight]) => ({ name, weight: parseFloat(weight.toFixed(2)) }))
      .sort((a, b) => b.weight - a.weight);

    return {
      schemeCode,
      portfolioDate: pdate,
      sectors,
      totalHoldingsCount: allHoldings.length,
      holdings: allHoldings,
    };
  }

  // ── 4. In-Place Comparison & Overlap ──────────────────────────────────────
  static compareMutualFunds(schemeCodes: number[], range: string = '1y') {
    if (!schemeCodes || schemeCodes.length === 0) {
      return { schemes: [], rebasedSeries: [], overlapMatrix: [] };
    }

    const validCodes = schemeCodes.slice(0, 4); // max 4 funds
    const startDate = getDateOffset(range);

    // 1. Fetch metadata for all funds
    const schemesInfo: any[] = [];
    const fundHistories: { [code: number]: { nav_date: string; nav: number }[] } = {};

    for (const code of validCodes) {
      const detail = this.getMutualFundDetail(code);
      if (detail) schemesInfo.push(detail);

      const rows = queryAll<{ nav_date: string; nav: number }>(`
        SELECT nav_date, nav FROM nav_history
        WHERE scheme_code = ? AND nav_date >= ?
        ORDER BY nav_date ASC
      `, [code, startDate]);
      fundHistories[code] = rows;
    }

    // 2. Find common dates across all selected funds
    const dateSets = validCodes.map(
      (c) => new Set((fundHistories[c] || []).map((r) => r.nav_date))
    );

    const commonDates = (fundHistories[validCodes[0]] || [])
      .map((r) => r.nav_date)
      .filter((d) => dateSets.every((s) => s.has(d)))
      .sort();

    // 3. Build rebased series (base 100 on common start date)
    const rebasedSeries: { date: string; [code: string]: number | string }[] = [];
    if (commonDates.length > 0) {
      const baseNavs: { [code: number]: number } = {};
      for (const code of validCodes) {
        const first = fundHistories[code]?.find((r) => r.nav_date === commonDates[0]);
        baseNavs[code] = first?.nav || 1;
      }

      for (const d of commonDates) {
        const point: any = { date: d };
        for (const code of validCodes) {
          const match = fundHistories[code]?.find((r) => r.nav_date === d);
          if (match && baseNavs[code] > 0) {
            point[code] = parseFloat(((match.nav / baseNavs[code]) * 100).toFixed(2));
          }
        }
        rebasedSeries.push(point);
      }
    }

    // 4. Calculate Portfolio Overlap Matrix between all pairs
    const holdingsMap: { [code: number]: { isin: string; name: string; weight: number }[] } = {};
    for (const code of validCodes) {
      const res = this.getMutualFundHoldings(code);
      holdingsMap[code] = (res.holdings || []).map((h: any) => ({
        isin: h.isin || h.instrument_name,
        name: h.instrument_name,
        weight: h.pct_nav || 0,
      }));
    }

    const overlapMatrix: any[] = [];
    for (let i = 0; i < validCodes.length; i++) {
      for (let j = i + 1; j < validCodes.length; j++) {
        const codeA = validCodes[i];
        const codeB = validCodes[j];
        const hA = holdingsMap[codeA] || [];
        const hB = holdingsMap[codeB] || [];

        const mapB = new Map<string, number>();
        hB.forEach((item) => mapB.set(item.isin, item.weight));

        let overlapWeight = 0;
        const commonHoldings: any[] = [];

        hA.forEach((item) => {
          if (mapB.has(item.isin)) {
            const wB = mapB.get(item.isin) || 0;
            const shared = Math.min(item.weight, wB);
            overlapWeight += shared;
            commonHoldings.push({
              name: item.name,
              isin: item.isin,
              weightA: item.weight,
              weightB: wB,
              overlap: parseFloat(shared.toFixed(2)),
            });
          }
        });

        commonHoldings.sort((a, b) => b.overlap - a.overlap);

        overlapMatrix.push({
          schemeA: codeA,
          schemeB: codeB,
          nameA: schemesInfo.find((s) => s.scheme_code === codeA)?.scheme_name,
          nameB: schemesInfo.find((s) => s.scheme_code === codeB)?.scheme_name,
          overlapPercentage: parseFloat(overlapWeight.toFixed(2)),
          commonCount: commonHoldings.length,
          topCommonHoldings: commonHoldings.slice(0, 10),
        });
      }
    }

    return {
      schemes: schemesInfo,
      rebasedSeries,
      overlapMatrix,
    };
  }

  // ── 5. Which Funds Hold This Stock? ──────────────────────────────────────
  static getFundsHoldingStock(identifier: string) {
    const q = `%${identifier.trim()}%`;
    const rows = queryAll(`
      SELECT h.amc, h.scheme_name, h.amfi_scheme_code, h.instrument_name,
             h.isin, h.pct_nav, h.market_value_lakhs, h.portfolio_date,
             n.nav, n.category
      FROM holdings h
      LEFT JOIN nav n ON n.scheme_code = CAST(h.amfi_scheme_code AS INTEGER)
      WHERE (h.isin = ? OR h.instrument_name LIKE ?)
        AND h.portfolio_date = (SELECT MAX(portfolio_date) FROM holdings)
      ORDER BY h.pct_nav DESC
      LIMIT 50
    `, [identifier.trim(), q]);

    return {
      query: identifier,
      count: rows.length,
      funds: rows,
    };
  }

  // ── 6. ETFs ──────────────────────────────────────────────────────────────
  static getEtfs(params: { assetClass?: string; search?: string; limit?: number; offset?: number }) {
    const limit = Math.min(params.limit || 20, 100);
    const offset = params.offset || 0;
    const conditions: string[] = ['1=1'];
    const sqlParams: any[] = [];

    if (params.assetClass) {
      conditions.push('m.asset_class LIKE ?');
      sqlParams.push(`%${params.assetClass}%`);
    }
    if (params.search) {
      conditions.push('(m.symbol LIKE ? OR m.security_name LIKE ? OR m.underlying_index LIKE ?)');
      sqlParams.push(`%${params.search}%`, `%${params.search}%`, `%${params.search}%`);
    }

    const where = conditions.join(' AND ');
    const countRow = queryOne<{ total: number }>(`SELECT COUNT(*) as total FROM etf_master m WHERE ${where}`, sqlParams);

    const maxDateRow = queryOne<{ dt: string }>(`SELECT MAX(trade_date) as dt FROM etf_prices`);
    const maxDate = maxDateRow?.dt || '2026-09-01';

    const items = queryAll(`
      SELECT m.symbol, m.isin, m.security_name, m.underlying_index, m.asset_class,
             p.close_price, p.prev_close, p.open_price, p.high_price, p.low_price,
             p.volume, p.value_lakhs, p.trade_date,
             ROUND(((p.close_price - p.prev_close) / p.prev_close) * 100, 2) as change_pct,
             ROUND(((p.close_price / h.nav) - 1) * 100, 2) as premium_pct
      FROM etf_master m
      LEFT JOIN etf_prices p ON p.symbol = m.symbol AND p.trade_date = ?
      LEFT JOIN nav_history h ON h.isin_growth = p.isin AND h.nav_date = p.trade_date
      WHERE ${where}
      ORDER BY p.value_lakhs DESC NULLS LAST
      LIMIT ? OFFSET ?
    `, [maxDate, ...sqlParams, limit, offset]);

    return {
      total: countRow?.total || 0,
      limit,
      offset,
      items,
    };
  }

  static getEtfDetail(symbol: string) {
    const etf = queryOne(`
      SELECT m.symbol, m.isin, m.security_name, m.underlying_asset, m.underlying_index,
             m.asset_class, m.listing_date, m.market_lot, m.face_value,
             p.close_price, p.prev_close, p.open_price, p.high_price, p.low_price,
             p.volume, p.value_lakhs, p.trade_date,
             ROUND(((p.close_price - p.prev_close) / p.prev_close) * 100, 2) as change_pct
      FROM etf_master m
      LEFT JOIN etf_prices p ON p.symbol = m.symbol AND p.trade_date = (SELECT MAX(trade_date) FROM etf_prices)
      WHERE m.symbol = ?
    `, [symbol.toUpperCase()]);

    if (!etf) return null;

    // Latest NAV
    const latestNavRow = queryOne<{ nav: number; nav_date: string }>(`
      SELECT nav, nav_date FROM nav_history WHERE isin_growth = ? ORDER BY nav_date DESC LIMIT 1
    `, [etf.isin]);

    const latestNav = latestNavRow?.nav || null;
    const premiumPct = latestNav && etf.close_price
      ? parseFloat((((etf.close_price / latestNav) - 1) * 100).toFixed(2))
      : null;

    return {
      ...etf,
      nav: latestNav,
      navDate: latestNavRow?.nav_date,
      premiumPct,
    };
  }

  static getEtfPriceHistory(symbol: string, range: string = '1y') {
    const startDate = getDateOffset(range);
    const sym = symbol.toUpperCase();

    const rows = queryAll<{
      trade_date: string;
      close_price: number;
      volume: number;
      nav: number;
      premium_pct: number;
    }>(`
      SELECT p.trade_date, p.close_price, p.volume, h.nav,
             ROUND(((p.close_price / h.nav) - 1) * 100, 2) as premium_pct
      FROM etf_prices p
      LEFT JOIN nav_history h ON h.isin_growth = p.isin AND h.nav_date = p.trade_date
      WHERE p.symbol = ? AND p.trade_date >= ?
      ORDER BY p.trade_date ASC
    `, [sym, startDate]);

    return {
      symbol: sym,
      range,
      count: rows.length,
      history: rows,
    };
  }

  // ── 7. Corporate Bonds ───────────────────────────────────────────────────
  static getCorporateBonds(params: {
    rating?: string;
    minYield?: number;
    maxYield?: number;
    issuer?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(params.limit || 20, 100);
    const offset = params.offset || 0;
    const conditions: string[] = ['1=1'];
    const sqlParams: any[] = [];

    if (params.rating) {
      conditions.push('b.ratings LIKE ?');
      sqlParams.push(`%${params.rating}%`);
    }
    if (params.issuer) {
      conditions.push('b.issuer LIKE ?');
      sqlParams.push(`%${params.issuer}%`);
    }
    if (params.minYield !== undefined) {
      conditions.push('t.ytm_pct >= ?');
      sqlParams.push(params.minYield);
    }
    if (params.maxYield !== undefined) {
      conditions.push('t.ytm_pct <= ?');
      sqlParams.push(params.maxYield);
    }

    const where = conditions.join(' AND ');
    const countRow = queryOne<{ total: number }>(`
      SELECT COUNT(DISTINCT b.isin) as total
      FROM bond_master b
      LEFT JOIN corp_bond_trades t ON t.isin = b.isin
      WHERE ${where}
    `, sqlParams);

    const items = queryAll(`
      SELECT b.isin, b.issuer, b.sector, b.face_value, b.allotment_date, b.redemption_date,
             b.coupon_pct, b.coupon_freq, b.ratings, b.seniority, b.secured,
             t.ltp as latest_price, t.ytm_pct as yield_to_maturity, t.trade_date as last_trade_date
      FROM bond_master b
      LEFT JOIN (
        SELECT isin, ltp, ytm_pct, trade_date,
               ROW_NUMBER() OVER (PARTITION BY isin ORDER BY trade_date DESC) as rn
        FROM corp_bond_trades
      ) t ON t.isin = b.isin AND t.rn = 1
      WHERE ${where}
      ORDER BY t.trade_date DESC NULLS LAST
      LIMIT ? OFFSET ?
    `, [...sqlParams, limit, offset]);

    return {
      total: countRow?.total || 0,
      limit,
      offset,
      items,
    };
  }

  static getCorporateBondDetail(isin: string) {
    const bond = queryOne(`
      SELECT isin, issuer, ownership, issuer_nature, sector, industry,
             instrument_type, description, face_value, allotment_date, redemption_date,
             perpetual, secured, seniority, tax_free, mode_of_issue, issue_size_cr,
             coupon_basis, coupon_pct, coupon_freq, day_count, ratings, fetched_on
      FROM bond_master
      WHERE isin = ?
    `, [isin.toUpperCase()]);

    if (!bond) return null;

    // Rating transitions
    const ratingActions = queryAll(`
      SELECT date, agency, rating, previous_rating, action
      FROM rating_actions
      WHERE isin = ?
      ORDER BY date DESC
    `, [isin.toUpperCase()]);

    // Recent trades
    const trades = queryAll(`
      SELECT trade_date, exchange, ltp, trade_value_lakhs, ytm_pct, wavg_price
      FROM corp_bond_trades
      WHERE isin = ?
      ORDER BY trade_date DESC LIMIT 15
    `, [isin.toUpperCase()]);

    const latestTrade = trades[0] || null;

    return {
      ...bond,
      latestTrade,
      ratingActions,
      recentTrades: trades,
    };
  }

  static getBondCashflows(isin: string) {
    const flows = queryAll(`
      SELECT isin, event, record_date, due_date, payment_date, amount_payable
      FROM bond_cashflows
      WHERE isin = ?
      ORDER BY due_date ASC
    `, [isin.toUpperCase()]);

    return {
      isin: isin.toUpperCase(),
      count: flows.length,
      cashflows: flows,
    };
  }

  static getCorporateBondSpread(isin: string) {
    const bond = queryOne<{ redemption_date: string; coupon_pct: number }>(`
      SELECT redemption_date, coupon_pct FROM bond_master WHERE isin = ?
    `, [isin.toUpperCase()]);

    const latestTrade = queryOne<{ ytm_pct: number }>(`
      SELECT ytm_pct FROM corp_bond_trades WHERE isin = ? AND ytm_pct > 0 ORDER BY trade_date DESC LIMIT 1
    `, [isin.toUpperCase()]);

    const bondYield = latestTrade?.ytm_pct || bond?.coupon_pct || 8.5;

    // Calculate tenor in years to maturity
    let tenorYears = 5.0;
    if (bond?.redemption_date) {
      const ms = new Date(bond.redemption_date).getTime() - Date.now();
      tenorYears = Math.max(1, Math.round((ms / (1000 * 60 * 60 * 24 * 365.25)) * 10) / 10);
    }

    // Benchmark G-Sec par yield for similar tenor
    const gsecMatch = queryOne<{ ytm_pct: number; tenor_years: number; date: string }>(`
      SELECT ytm_pct, tenor_years, date FROM gsec
      WHERE isin LIKE 'PAR_YIELD_%' AND date = (SELECT MAX(date) FROM gsec)
      ORDER BY ABS(tenor_years - ?) ASC LIMIT 1
    `, [tenorYears]) || { ytm_pct: 6.82, tenor_years: 5.0, date: new Date().toISOString().split('T')[0] };

    const spreadBps = Math.round((bondYield - gsecMatch.ytm_pct) * 100);

    return {
      isin: isin.toUpperCase(),
      bondYield: parseFloat(bondYield.toFixed(2)),
      gsecYield: parseFloat(gsecMatch.ytm_pct.toFixed(2)),
      gsecTenorYears: gsecMatch.tenor_years,
      spreadBps,
      asOfDate: gsecMatch.date,
    };
  }

  // ── 8. Government Securities ─────────────────────────────────────────────
  static getGSecYieldCurve() {
    const curve = queryAll(`
      SELECT tenor_years, ytm_pct, date
      FROM gsec
      WHERE isin LIKE 'PAR_YIELD_%' AND date = (SELECT MAX(date) FROM gsec WHERE isin LIKE 'PAR_YIELD_%')
      ORDER BY tenor_years ASC
    `);

    const tbills = queryAll(`
      SELECT isin, tenor_days, ytm_pct, date
      FROM gsec
      WHERE security_type = 'T-Bill' AND date = (SELECT MAX(date) FROM gsec WHERE security_type = 'T-Bill')
      ORDER BY tenor_days ASC
    `);

    return {
      asOfDate: curve[0]?.date || new Date().toISOString().split('T')[0],
      parYieldCurve: curve,
      tbills,
    };
  }

  // ── 9. Fixed Deposits ────────────────────────────────────────────────────
  static getFdRates() {
    const rates = queryAll(`
      SELECT bank, product, tenor_label, tenor_min_days, tenor_max_days,
             rate_general, rate_senior, effective_date
      FROM fd_rates
      ORDER BY rate_general DESC
    `);

    return {
      count: rates.length,
      rates,
    };
  }
}
