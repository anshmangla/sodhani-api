import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool, testPool } from './helpers';
import { TEST_RA2_ID } from './constants';

// Fixed, RFC-4122-shaped ids (unlike TEST_RA_ID/TEST_RA2_ID, which are
// deliberately not version-4 compliant) so they pass the same UUID_REGEX
// that src/routes/analysts.ts reuses from raCalls.ts to validate :id.
//
// Deliberately no beforeEach(clearCallsData) in this file: it would race
// test/raCalls.test.ts's own clearCallsData under vitest's default parallel
// file execution, since both would be truncating the same shared
// research_calls table concurrently. Tests here that exercise
// research_calls-backed behavior (call stats, pagination, the paywall) live
// in test/raCalls.test.ts instead, which already owns clearCallsData.
const FIXTURE_ANALYST_ID = '00000000-0000-4000-8000-000000000201';
const FIXTURE_INACTIVE_ANALYST_ID = '00000000-0000-4000-8000-000000000202';
const WELL_FORMED_MISSING_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  // Give TEST_RA2_ID a designation so analyst search has something to match
  // on besides the name.
  await testPool.query(`UPDATE research_analysts SET designation = 'Equity Research Analyst' WHERE id = $1`, [
    TEST_RA2_ID,
  ]);

  await testPool.query(
    `INSERT INTO research_analysts (id, email, password_hash, full_name, designation, is_active, token_version)
     VALUES ($1, 'fixture-analyst-active@example.com', 'not-a-real-hash', 'Fixture Analyst', 'Chief Analyst', true, 0)
     ON CONFLICT (id) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       designation = EXCLUDED.designation,
       is_active = true,
       token_version = 0`,
    [FIXTURE_ANALYST_ID]
  );

  await testPool.query(
    `INSERT INTO research_analysts (id, email, password_hash, full_name, designation, is_active, token_version)
     VALUES ($1, 'fixture-analyst-inactive@example.com', 'not-a-real-hash', 'Inactive Analyst', 'Inactive Role', false, 0)
     ON CONFLICT (id) DO UPDATE SET is_active = false, token_version = 0`,
    [FIXTURE_INACTIVE_ANALYST_ID]
  );
});

afterAll(closeTestPool);

describe('GET /api/ra/companies?search= (analyst search extension)', () => {
  it('keeps returning companies unchanged (backward compatibility)', async () => {
    const res = await request(app).get('/api/ra/companies?search=RELIANCE');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.companies)).toBe(true);
  });

  it('also returns matching analysts by name, with the AnalystSummary shape', async () => {
    const res = await request(app).get('/api/ra/companies?search=Fixture Analyst');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.analysts)).toBe(true);
    const match = res.body.analysts.find((a: { id: string }) => a.id === FIXTURE_ANALYST_ID);
    expect(match).toMatchObject({
      id: FIXTURE_ANALYST_ID,
      name: 'Fixture Analyst',
      designation: 'Chief Analyst',
    });
    // Not pinning an exact value: test/profilePicture.test.ts's
    // clearProfilePictures() nulls every RA's profile_picture_url and can
    // run concurrently with this file. Only the field's presence/shape is
    // this test's concern.
    expect(['string', 'object']).toContain(typeof match.profile_picture_url);
  });

  it('matches analysts by designation', async () => {
    const res = await request(app).get('/api/ra/companies?search=Equity Research');
    expect(res.status).toBe(200);
    const ids = res.body.analysts.map((a: { id: string }) => a.id);
    expect(ids).toContain(TEST_RA2_ID);
  });

  it('excludes inactive analysts from search results', async () => {
    const res = await request(app).get('/api/ra/companies?search=Inactive Analyst');
    expect(res.status).toBe(200);
    const ids = res.body.analysts.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(FIXTURE_INACTIVE_ANALYST_ID);
  });
});

describe('GET /api/analyst/:id (public analyst profile)', () => {
  it('404s for a malformed id', async () => {
    const res = await request(app).get('/api/analyst/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Analyst not found' });
  });

  it('404s for a well-formed id that does not exist', async () => {
    const res = await request(app).get(`/api/analyst/${WELL_FORMED_MISSING_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Analyst not found' });
  });

  it('404s for a deactivated analyst', async () => {
    const res = await request(app).get(`/api/analyst/${FIXTURE_INACTIVE_ANALYST_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Analyst not found' });
  });
});

describe('GET /api/analyst/:id/calls (paginated calls)', () => {
  it('404s for a malformed id', async () => {
    const res = await request(app).get('/api/analyst/not-a-uuid/calls');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Analyst not found' });
  });

  it('404s for a deactivated analyst', async () => {
    const res = await request(app).get(`/api/analyst/${FIXTURE_INACTIVE_ANALYST_ID}/calls`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Analyst not found' });
  });
});
