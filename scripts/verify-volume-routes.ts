import request from 'supertest';
import { app } from '../src/app';

async function runLiveRouteTests() {
  console.log('=== Running Live Route Verification against Local PostgreSQL ===\n');

  // Test 1: Dual-Listed ABB by BSE Scrip Code (500002)
  console.log('1. Testing GET /api/volume/500002?range=1d (Dual-listed BSE code)...');
  const res1 = await request(app).get('/api/volume/500002?range=1d');
  console.log('Status:', res1.status);
  console.log('Response summary:', {
    symbol: res1.body.symbol,
    is_dual_listed: res1.body.is_dual_listed,
    exchange_codes: res1.body.exchange_codes,
    count: res1.body.count,
    latest: res1.body.history?.[0]
  });
  if (res1.status !== 200 || !res1.body.is_dual_listed) {
    throw new Error('Test 1 failed: Expected status 200 and is_dual_listed = true');
  }

  // Test 2: Dual-Listed ABB by NSE Symbol (ABB)
  console.log('\n2. Testing GET /api/volume/ABB?range=1d (Dual-listed NSE ticker)...');
  const res2 = await request(app).get('/api/volume/ABB?range=1d');
  console.log('Status:', res2.status);
  console.log('Response summary:', {
    symbol: res2.body.symbol,
    is_dual_listed: res2.body.is_dual_listed,
    exchange_codes: res2.body.exchange_codes,
    combined_volume: res2.body.history?.[0]?.combined_volume
  });
  if (res2.status !== 200 || res2.body.history?.[0]?.combined_volume !== res1.body.history?.[0]?.combined_volume) {
    throw new Error('Test 2 failed: Mismatch between BSE code and NSE symbol query');
  }

  // Test 3: BSE-Only Stock (500012)
  console.log('\n3. Testing GET /api/volume/500012?range=1d (BSE-only)...');
  const res3 = await request(app).get('/api/volume/500012?range=1d');
  console.log('Status:', res3.status);
  console.log('Response summary:', {
    symbol: res3.body.symbol,
    is_dual_listed: res3.body.is_dual_listed,
    exchange_codes: res3.body.exchange_codes,
    bse_scrip: res3.body.history?.[0]?.bse?.scrip_cd,
    nse: res3.body.history?.[0]?.nse
  });
  if (res3.status !== 200 || res3.body.is_dual_listed !== false || res3.body.history?.[0]?.nse !== null) {
    throw new Error('Test 3 failed: BSE-only stock marked as dual-listed or nse not null');
  }

  // Test 4: Weekly Bucketing (ABB, range=1y)
  console.log('\n4. Testing GET /api/volume/ABB?range=1y (Weekly bucketing)...');
  const res4 = await request(app).get('/api/volume/ABB?range=1y');
  console.log('Status:', res4.status);
  console.log('Count:', res4.body.count);
  console.log('First weekly bucket:', res4.body.history?.[0]);
  if (res4.status !== 200 || res4.body.count < 10) {
    throw new Error('Test 4 failed: Expected weekly buckets count >= 10');
  }

  // Test 5: Line Downsampling (ABB, range=max, chartType=line)
  console.log('\n5. Testing GET /api/volume/ABB?range=max&chartType=line (LTTB downsampling)...');
  const res5 = await request(app).get('/api/volume/ABB?range=max&chartType=line');
  console.log('Status:', res5.status);
  console.log('Count:', res5.body.count);
  console.log('Sample downsampled point:', res5.body.history?.[0]);
  if (res5.status !== 200 || res5.body.count !== 100 || !res5.body.history?.[0]?.combined_volume) {
    throw new Error('Test 5 failed: Expected 100 downsampled points');
  }

  // Test 6: Enriched Quote (/api/quote/ABB)
  console.log('\n6. Testing GET /api/quote/ABB (Enriched Quote with volume & delivery)...');
  const res6 = await request(app).get('/api/quote/ABB');
  console.log('Status:', res6.status);
  console.log('Enriched quote volume metrics:', {
    TckrSymb: res6.body.TckrSymb,
    CombinedVolume: res6.body.CombinedVolume,
    BseVolume: res6.body.BseVolume,
    NseVolume: res6.body.NseVolume,
    DeliveryQty: res6.body.DeliveryQty,
    DeliveryPct: res6.body.DeliveryPct,
    IsDualListed: res6.body.IsDualListed
  });
  if (res6.status !== 200 || !res6.body.IsDualListed || !res6.body.CombinedVolume) {
    throw new Error('Test 6 failed: Quote not enriched with volume/delivery fields');
  }

  console.log('\n=== All 6 Live Route Tests Passed Successfully! ===');
  process.exit(0);
}

runLiveRouteTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
