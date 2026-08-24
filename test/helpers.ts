import { Pool } from 'pg';
import { signAuthToken } from '../src/auth/jwt';
import { testDbUrl } from './constants';

export const testPool = new Pool({ connectionString: testDbUrl() });

export function authHeader(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signAuthToken(userId, 0)}` };
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
