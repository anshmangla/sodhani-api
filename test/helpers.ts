import { Pool } from 'pg';
import { rm } from 'fs/promises';
import { join } from 'path';
import { signAuthToken } from '../src/auth/jwt';
import { signRaAuthToken } from '../src/auth/raJwt';
import { testDbUrl } from './constants';

export const testPool = new Pool({ connectionString: testDbUrl() });

export function authHeader(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signAuthToken(userId, 0)}` };
}

export function raAuthHeader(raId: string): Record<string, string> {
  return { Authorization: `Bearer ${signRaAuthToken(raId, 0)}` };
}

// Reset profile_picture_url between tests and wipe anything written to disk
// by the upload endpoints, so tests don't leak files across runs.
export async function clearProfilePictures(): Promise<void> {
  await testPool.query('UPDATE users SET profile_picture_url = NULL');
  await testPool.query('UPDATE research_analysts SET profile_picture_url = NULL');
  await rm(join(__dirname, '..', 'uploads', 'profile-pictures'), { recursive: true, force: true });
}

// Clear all watchlist data between tests (users + market data persist).
export async function clearWatchlistData(): Promise<void> {
  await testPool.query('DELETE FROM watchlist_playlist_items');
  await testPool.query('DELETE FROM watchlist_playlists');
  await testPool.query('DELETE FROM watchlist_items');
}

// Clear all RA-calls data between tests (users/RAs + market data persist).
// Deleted in FK-dependency order: ra_transfers/purchased_calls/call_comments
// all reference research_calls, and purchased_calls also references payments.
export async function clearCallsData(): Promise<void> {
  await testPool.query('DELETE FROM ra_transfers');
  await testPool.query('DELETE FROM purchased_calls');
  await testPool.query('DELETE FROM call_comments');
  await testPool.query('DELETE FROM payments');
  await testPool.query('DELETE FROM research_calls');
}

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}
