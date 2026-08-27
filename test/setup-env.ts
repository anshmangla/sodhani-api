// Runs in-process before each test file. Sets env before `app` (and therefore
// `pool.ts`) is imported, so the API binds to the test database and a known
// JWT secret. `dotenv.config()` inside pool.ts won't override these because
// dotenv never clobbers already-set environment variables.
import { testDbUrl, TEST_JWT_SECRET, TEST_RA_JWT_SECRET } from './constants';

process.env.DATABASE_URL = testDbUrl();
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.RA_JWT_SECRET = TEST_RA_JWT_SECRET;
