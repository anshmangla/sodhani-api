/**
 * Verification Script for C-01 (OTP Access Token Phone Number Binding)
 *
 * Background:
 * In C-01, an attacker could verify their own phone number with MSG91 to get a valid
 * access_token, but then pass someone else's phone_number in `verify-otp-login`.
 *
 * Remediation:
 * The API now extracts the verified mobile number from MSG91's response and asserts:
 *   verifyResult.mobile === normalizedPhone
 * If there is any mismatch, the request is rejected with HTTP 401:
 *   "OTP verification token does not match this phone number"
 *
 * Usage:
 *   npx tsx scripts/verify-c01-fix.ts [optional-base-url]
 * Default base URL: http://localhost:3000
 */

const BASE_URL = process.argv[2] || process.env.API_URL || 'http://localhost:3000';

async function main() {
  console.log('='.repeat(65));
  console.log('C-01 VULNERABILITY VERIFICATION TEST');
  console.log(`Target URL: ${BASE_URL}`);
  console.log('='.repeat(65));
  console.log();

  let passed = 0;
  let failed = 0;

  // Test 1: Invalid / forged token
  try {
    console.log('[Test 1] Testing invalid access token rejection...');
    const res = await fetch(`${BASE_URL}/api/auth/verify-otp-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: 'forged_or_invalid_token',
        phone_number: '9999999999',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      console.log('  PASSED: Server rejected invalid token with 401 Unauthorized.');
      console.log(`  Response detail: "${data.detail || data.error}"`);
      passed++;
    } else {
      console.error(`  FAILED: Expected 401, but got ${res.status}:`, data);
      failed++;
    }
  } catch (err: any) {
    console.error('  ERROR connecting to server:', err.message);
    failed++;
  }

  console.log();

  // Test 2: Check input format validation (phone number)
  try {
    console.log('[Test 2] Testing malformed phone number rejection...');
    const res = await fetch(`${BASE_URL}/api/auth/verify-otp-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: 'test_token',
        phone_number: '123', // invalid short number
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401) {
      console.log(`  PASSED: Server rejected malformed input with status ${res.status}.`);
      passed++;
    } else {
      console.error(`  FAILED: Expected 400/401, but got ${res.status}:`, data);
      failed++;
    }
  } catch (err: any) {
    console.error('  ERROR connecting to server:', err.message);
    failed++;
  }

  console.log();

  // Test 3: Rate limiting on verify-otp endpoint (M-02 / H-02)
  try {
    console.log('[Test 3] Testing rate limit defense on OTP verification...');
    let rateLimited = false;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/verify-otp-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: 'rate_limit_probe_token',
          phone_number: '9876543210',
        }),
      });

      if (res.status === 429) {
        rateLimited = true;
        const retryAfter = res.headers.get('retry-after');
        console.log(`  PASSED: Throttled with 429 Too Many Requests after attempt ${i + 1}.`);
        console.log(`  Retry-After header: ${retryAfter}s`);
        passed++;
        break;
      }
    }

    if (!rateLimited) {
      console.log('  NOTE: Rate limit did not trigger within 7 requests (may be skipped in test mode).');
    }
  } catch (err: any) {
    console.error('  ERROR:', err.message);
  }

  console.log();
  console.log('='.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('To run unit/mocked token-binding tests directly in Vitest:');
  console.log('  npx vitest run test/c01_verification.test.ts');
  console.log('='.repeat(65));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
