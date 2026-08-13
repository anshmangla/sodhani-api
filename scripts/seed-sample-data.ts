import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../src/db/pool';

// Dev-only sample data so the app has something to show in the calls feed.
// Idempotent: every insert is keyed off a natural identity and skipped with
// `ON CONFLICT ... DO NOTHING` if it already exists, so re-running is safe.
// Requires `npm run seed:ra` to have been run first (this script looks up
// analysts by username rather than creating them).

type SampleCall = {
  raUsername: string;
  scripCode: string;
  companyName: string;
  recommendation: 'Buy' | 'Hold' | 'Sell';
  currentPriceAtPublish: number;
  volumeAtPublish: number;
  targetPrice: number;
  stopLoss: number;
  buyingRange: string;
  holdingPeriod: string;
  isPaid: boolean;
  pricePaise: number | null;
  status: 'open' | 'closed';
  comment?: string;
};

const SAMPLE_CALLS: SampleCall[] = [
  {
    raUsername: 'rajesh.kumar',
    scripCode: '500325',
    companyName: 'Reliance Industries Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 2870.5,
    volumeAtPublish: 4_200_000,
    targetPrice: 3150,
    stopLoss: 2720,
    buyingRange: '2850-2900',
    holdingPeriod: '6-9 months',
    isPaid: false,
    pricePaise: null,
    status: 'open',
    comment: 'Reiterating our bullish view after the strong retail and Jio segment numbers this quarter.',
  },
  {
    raUsername: 'rajesh.kumar',
    scripCode: '532540',
    companyName: 'Tata Consultancy Services Ltd.',
    recommendation: 'Hold',
    currentPriceAtPublish: 3950,
    volumeAtPublish: 1_100_000,
    targetPrice: 4100,
    stopLoss: 3760,
    buyingRange: '3900-3960',
    holdingPeriod: '3-6 months',
    isPaid: false,
    pricePaise: null,
    status: 'open',
  },
  {
    raUsername: 'rajesh.kumar',
    scripCode: '500180',
    companyName: 'HDFC Bank Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 1685.25,
    volumeAtPublish: 6_500_000,
    targetPrice: 1850,
    stopLoss: 1590,
    buyingRange: '1670-1700',
    holdingPeriod: '6-12 months',
    isPaid: true,
    pricePaise: 4900,
    status: 'open',
    comment: 'Deposit growth and NIM stabilization support a re-rating from here.',
  },
  {
    raUsername: 'priya.sharma',
    scripCode: '500209',
    companyName: 'Infosys Ltd.',
    recommendation: 'Sell',
    currentPriceAtPublish: 1520,
    volumeAtPublish: 3_300_000,
    targetPrice: 1380,
    stopLoss: 1595,
    buyingRange: '1500-1530',
    holdingPeriod: '1-3 months',
    isPaid: false,
    pricePaise: null,
    status: 'closed',
    comment: 'Target hit — booking out as guided in the original call.',
  },
  {
    raUsername: 'priya.sharma',
    scripCode: '500875',
    companyName: 'ITC Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 465.1,
    volumeAtPublish: 8_900_000,
    targetPrice: 520,
    stopLoss: 435,
    buyingRange: '460-470',
    holdingPeriod: '6-9 months',
    isPaid: true,
    pricePaise: 9900,
    status: 'open',
  },
  {
    raUsername: 'priya.sharma',
    scripCode: '500112',
    companyName: 'State Bank of India',
    recommendation: 'Hold',
    currentPriceAtPublish: 825.4,
    volumeAtPublish: 5_700_000,
    targetPrice: 870,
    stopLoss: 780,
    buyingRange: '815-830',
    holdingPeriod: '3-6 months',
    isPaid: false,
    pricePaise: null,
    status: 'open',
  },
  {
    raUsername: 'amit.verma',
    scripCode: '500570',
    companyName: 'Tata Motors Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 985.6,
    volumeAtPublish: 7_100_000,
    targetPrice: 1150,
    stopLoss: 910,
    buyingRange: '970-1000',
    holdingPeriod: '9-12 months',
    isPaid: true,
    pricePaise: 14900,
    status: 'open',
    comment: 'JLR order book and EV ramp-up make this our top auto pick this quarter.',
  },
  {
    raUsername: 'amit.verma',
    scripCode: '507685',
    companyName: 'Wipro Ltd.',
    recommendation: 'Sell',
    currentPriceAtPublish: 268.75,
    volumeAtPublish: 2_400_000,
    targetPrice: 240,
    stopLoss: 282,
    buyingRange: '265-272',
    holdingPeriod: '1-3 months',
    isPaid: false,
    pricePaise: null,
    status: 'closed',
  },
  {
    raUsername: 'amit.verma',
    scripCode: '500510',
    companyName: 'Larsen & Toubro Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 3610,
    volumeAtPublish: 1_800_000,
    targetPrice: 3950,
    stopLoss: 3420,
    buyingRange: '3580-3630',
    holdingPeriod: '6-9 months',
    isPaid: false,
    pricePaise: null,
    status: 'open',
  },
  {
    raUsername: 'rajesh.kumar',
    scripCode: '532215',
    companyName: 'Axis Bank Ltd.',
    recommendation: 'Hold',
    currentPriceAtPublish: 1145.3,
    volumeAtPublish: 4_000_000,
    targetPrice: 1210,
    stopLoss: 1080,
    buyingRange: '1130-1155',
    holdingPeriod: '3-6 months',
    isPaid: true,
    pricePaise: 7900,
    status: 'open',
  },
  {
    raUsername: 'priya.sharma',
    scripCode: '532500',
    companyName: 'Maruti Suzuki India Ltd.',
    recommendation: 'Buy',
    currentPriceAtPublish: 12450,
    volumeAtPublish: 380_000,
    targetPrice: 13800,
    stopLoss: 11700,
    buyingRange: '12300-12550',
    holdingPeriod: '9-12 months',
    isPaid: true,
    pricePaise: 19900,
    status: 'open',
    comment: 'New SUV launch pipeline and rural demand recovery both support the upgrade.',
  },
  {
    raUsername: 'amit.verma',
    scripCode: '524715',
    companyName: 'Sun Pharmaceutical Industries Ltd.',
    recommendation: 'Sell',
    currentPriceAtPublish: 1780,
    volumeAtPublish: 1_500_000,
    targetPrice: 1620,
    stopLoss: 1860,
    buyingRange: '1760-1795',
    holdingPeriod: '1-3 months',
    isPaid: false,
    pricePaise: null,
    status: 'open',
  },
];

// One consumer account + a completed purchase, so the "purchased calls" /
// entitlement view has something to show too. Phone number is a fake dev
// number — this account is only reachable via direct DB access, not real OTP
// login, since it exists purely to have purchase history to look at.
const DEMO_USER = {
  name: 'Demo User',
  phoneNumber: '919999900000',
};
const DEMO_USER_PURCHASES_SCRIP_CODE = '500180'; // the HDFC Bank paid call above

async function main() {
  const raIds = new Map<string, string>();
  for (const username of ['rajesh.kumar', 'priya.sharma', 'amit.verma']) {
    const result = await pool.query('SELECT id FROM research_analysts WHERE lower(username) = lower($1)', [
      username,
    ]);
    if (result.rows.length === 0) {
      console.error(
        `Research analyst '${username}' not found — run \`npm run seed:ra\` first.`
      );
      process.exit(1);
    }
    raIds.set(username, result.rows[0].id);
  }

  const callIdByScripCode = new Map<string, string>();
  for (const call of SAMPLE_CALLS) {
    const raId = raIds.get(call.raUsername)!;
    const result = await pool.query(
      `INSERT INTO research_calls (
         ra_id, scrip_code, company_name, recommendation, current_price_at_publish,
         volume_at_publish, target_price, stop_loss, buying_range, holding_period,
         is_paid, price_paise, status
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       WHERE NOT EXISTS (
         SELECT 1 FROM research_calls WHERE ra_id = $1 AND scrip_code = $2 AND recommendation = $4
       )
       RETURNING id`,
      [
        raId,
        call.scripCode,
        call.companyName,
        call.recommendation,
        call.currentPriceAtPublish,
        call.volumeAtPublish,
        call.targetPrice,
        call.stopLoss,
        call.buyingRange,
        call.holdingPeriod,
        call.isPaid,
        call.pricePaise,
        call.status,
      ]
    );

    let callId: string;
    if (result.rows.length > 0) {
      callId = result.rows[0].id;
      console.log(`Created call: ${call.companyName} (${call.recommendation}) by ${call.raUsername}`);
    } else {
      const existing = await pool.query(
        'SELECT id FROM research_calls WHERE ra_id = $1 AND scrip_code = $2 AND recommendation = $3',
        [raId, call.scripCode, call.recommendation]
      );
      callId = existing.rows[0].id;
      console.log(`Call already exists, skipped: ${call.companyName} (${call.recommendation})`);
    }
    callIdByScripCode.set(call.scripCode, callId);

    if (call.comment) {
      await pool.query(
        `INSERT INTO call_comments (call_id, ra_id, body)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM call_comments WHERE call_id = $1 AND body = $3)`,
        [callId, raId, call.comment]
      );
    }
  }

  const userResult = await pool.query(
    `INSERT INTO users (name, phone_number, auth_provider)
     VALUES ($1, $2, 'otp')
     ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [DEMO_USER.name, DEMO_USER.phoneNumber]
  );
  const userId = userResult.rows[0].id;
  console.log(`Demo user ready: ${DEMO_USER.name} (${DEMO_USER.phoneNumber})`);

  const purchasedCallId = callIdByScripCode.get(DEMO_USER_PURCHASES_SCRIP_CODE)!;
  const paymentResult = await pool.query(
    `INSERT INTO payments (user_id, call_id, razorpay_order_id, razorpay_payment_id, amount_paise, status)
     SELECT $1, $2, $3, $4, $5, 'paid'
     WHERE NOT EXISTS (SELECT 1 FROM payments WHERE razorpay_order_id = $3)
     RETURNING id`,
    [userId, purchasedCallId, 'order_seed_demo_hdfcbank', 'pay_seed_demo_hdfcbank', 4900]
  );

  let paymentId: string;
  if (paymentResult.rows.length > 0) {
    paymentId = paymentResult.rows[0].id;
  } else {
    const existing = await pool.query('SELECT id FROM payments WHERE razorpay_order_id = $1', [
      'order_seed_demo_hdfcbank',
    ]);
    paymentId = existing.rows[0].id;
  }

  await pool.query(
    `INSERT INTO purchased_calls (user_id, call_id, payment_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, call_id) DO NOTHING`,
    [userId, purchasedCallId, paymentId]
  );
  console.log(`Demo user purchase recorded for scrip ${DEMO_USER_PURCHASES_SCRIP_CODE}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
