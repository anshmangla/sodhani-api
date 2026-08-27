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

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}
