import { pool } from '../db/pool';

// Platform-wide generalizations of raTransfersService.ts's per-RA functions,
// with the `WHERE ra_id = $1` filter dropped. Two concepts stay distinct:
// `payments` = revenue IN from users; `ra_transfers` = payouts OUT to RAs.

export type PlatformRevenueSummary = {
  totalPaise: number;
  thisMonthPaise: number;
  thisYearPaise: number;
  failedPaymentCount: number;
};

export async function getPlatformRevenueSummary(): Promise<PlatformRevenueSummary> {
  const result = await pool.query(`
    SELECT
      COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0) AS total_paise,
      COALESCE(SUM(amount_paise) FILTER (
        WHERE status = 'paid'
          AND date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')
            = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
      ), 0) AS this_month_paise,
      COALESCE(SUM(amount_paise) FILTER (
        WHERE status = 'paid'
          AND date_trunc('year', created_at AT TIME ZONE 'Asia/Kolkata')
            = date_trunc('year', now() AT TIME ZONE 'Asia/Kolkata')
      ), 0) AS this_year_paise,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_payment_count
    FROM payments
  `);
  const row = result.rows[0];
  return {
    totalPaise: Number(row.total_paise),
    thisMonthPaise: Number(row.this_month_paise),
    thisYearPaise: Number(row.this_year_paise),
    failedPaymentCount: Number(row.failed_payment_count),
  };
}

export type RevenueDay = { day: string; amountPaise: number };

export async function getRevenueOverTime(days: number): Promise<RevenueDay[]> {
  const result = await pool.query(
    `SELECT d::date AS day, COALESCE(p.amount_paise, 0)::bigint AS amount_paise
     FROM generate_series(current_date - ($1::int - 1) * interval '1 day', current_date, interval '1 day') d
     LEFT JOIN (
       SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, SUM(amount_paise) AS amount_paise
       FROM payments WHERE status = 'paid' GROUP BY 1
     ) p ON p.day = d::date
     ORDER BY d`,
    [days]
  );
  return result.rows.map((row) => ({ day: row.day, amountPaise: Number(row.amount_paise) }));
}

export type RaRevenueRow = {
  raId: string;
  raName: string;
  totalPaise: number;
  count: number;
};

export async function getRevenueByRa(limit: number): Promise<RaRevenueRow[]> {
  const result = await pool.query(
    `SELECT ra.id AS ra_id, ra.full_name AS ra_name, SUM(p.amount_paise) AS total_paise, COUNT(*) AS count
     FROM payments p
     JOIN research_calls rc ON rc.id = p.call_id
     JOIN research_analysts ra ON ra.id = rc.ra_id
     WHERE p.status = 'paid'
     GROUP BY ra.id, ra.full_name
     ORDER BY total_paise DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    raId: row.ra_id,
    raName: row.ra_name,
    totalPaise: Number(row.total_paise),
    count: Number(row.count),
  }));
}

export type PaymentsFilter = {
  status?: 'created' | 'paid' | 'failed';
  userId?: string;
  raId?: string;
  callId?: string;
  from?: string;
  to?: string;
};

export type PaginatedResult<T> = {
  rows: T[];
  total: number;
};

export async function getPaymentsList(
  filters: PaymentsFilter,
  page: number,
  limit: number
): Promise<PaginatedResult<any>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    conditions.push(`p.user_id = $${params.length}`);
  }
  if (filters.raId) {
    params.push(filters.raId);
    conditions.push(`rc.ra_id = $${params.length}`);
  }
  if (filters.callId) {
    params.push(filters.callId);
    conditions.push(`p.call_id = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`p.created_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`p.created_at <= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM payments p JOIN research_calls rc ON rc.id = p.call_id ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT p.id, p.status, p.amount_paise, p.razorpay_order_id, p.razorpay_payment_id, p.created_at,
            u.id AS user_id, u.name AS user_name, u.phone_number AS user_phone_number,
            rc.id AS call_id, rc.company_name, ra.id AS ra_id, ra.full_name AS ra_name
     FROM payments p
     JOIN users u ON u.id = p.user_id
     JOIN research_calls rc ON rc.id = p.call_id
     JOIN research_analysts ra ON ra.id = rc.ra_id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return { rows: dataResult.rows, total };
}

export type PayoutsFilter = {
  raId?: string;
  status?: 'processed' | 'failed';
  settlementStatus?: 'pending' | 'settled';
};

export async function getPayoutsList(
  filters: PayoutsFilter,
  page: number,
  limit: number
): Promise<PaginatedResult<any>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.raId) {
    params.push(filters.raId);
    conditions.push(`rt.ra_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`rt.status = $${params.length}`);
  }
  if (filters.settlementStatus) {
    params.push(filters.settlementStatus);
    conditions.push(`rt.settlement_status = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM ra_transfers rt ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT rt.id, rt.amount_paise, rt.status, rt.settlement_status, rt.error_description,
            rt.processed_at, rt.settled_at, rt.razorpay_transfer_id, rt.razorpay_settlement_utr,
            ra.id AS ra_id, ra.full_name AS ra_name, rc.id AS call_id, rc.company_name
     FROM ra_transfers rt
     JOIN research_analysts ra ON ra.id = rt.ra_id
     JOIN research_calls rc ON rc.id = rt.call_id
     ${whereClause}
     ORDER BY rt.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return { rows: dataResult.rows, total };
}
