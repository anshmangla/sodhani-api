import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app } from '../src/app';
import {
  authHeader,
  clearWatchlistData,
  closeTestPool,
} from './helpers';
import { TEST_USER_ID, TEST_USER2_ID } from './constants';

beforeEach(clearWatchlistData);
afterAll(closeTestPool);

describe('watchlist auth', () => {
  const paths = [
    { method: 'get', url: '/api/watchlist' },
    { method: 'post', url: '/api/watchlist' },
    { method: 'delete', url: '/api/watchlist/RELIANCE' },
    { method: 'get', url: '/api/watchlist/playlists' },
    { method: 'post', url: '/api/watchlist/playlists' },
    { method: 'patch', url: '/api/watchlist/playlists/reorder' },
    { method: 'patch', url: '/api/watchlist/playlists/some-id' },
    { method: 'delete', url: '/api/watchlist/playlists/some-id' },
    { method: 'get', url: '/api/watchlist/playlists/some-id/items' },
    { method: 'post', url: '/api/watchlist/playlists/some-id/items' },
    { method: 'delete', url: '/api/watchlist/playlists/some-id/items/RELIANCE' },
    { method: 'patch', url: '/api/watchlist/playlists/some-id/items/reorder' },
    { method: 'get', url: '/api/watchlist/playlists/memberships' },
  ];

  it.each(paths)('$method $url returns 401 without a token', async ({ method, url }) => {
    const res = await (request(app) as any)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('watchlist items', () => {
  it('adds a symbol (201) then is idempotent (200)', async () => {
    const res1 = await request(app)
      .post('/api/watchlist')
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'reliance' });
    expect(res1.status).toBe(201);
    expect(res1.body.symbol).toBe('RELIANCE');

    const res2 = await request(app)
      .post('/api/watchlist')
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'RELIANCE' });
    expect(res2.status).toBe(200);
  });

  it('rejects an unknown symbol (404) and a missing symbol (400)', async () => {
    const res404 = await request(app)
      .post('/api/watchlist')
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'NOPE' });
    expect(res404.status).toBe(404);

    const res400 = await request(app)
      .post('/api/watchlist')
      .set(authHeader(TEST_USER_ID))
      .send({});
    expect(res400.status).toBe(400);
  });

  it('lists items with server-joined prices', async () => {
    await request(app).post('/api/watchlist').set(authHeader(TEST_USER_ID)).send({ symbol: 'RELIANCE' });
    await request(app).post('/api/watchlist').set(authHeader(TEST_USER_ID)).send({ symbol: 'INFY' });

    const res = await request(app).get('/api/watchlist').set(authHeader(TEST_USER_ID));
    expect(res.status).toBe(200);
    const reliance = res.body.items.find((i: any) => i.symbol === 'RELIANCE');
    expect(reliance).toBeDefined();
    expect(reliance.name).toBe('Reliance Industries Ltd');
    expect(reliance.price).toBe(3000);
    expect(reliance.change).toBe(50);
    expect(reliance.change_percent).toBeCloseTo((50 / 2950) * 100, 1);
  });

  it('returns null price for a symbol with no history', async () => {
    await request(app).post('/api/watchlist').set(authHeader(TEST_USER_ID)).send({ symbol: 'TCS' });
    const res = await request(app).get('/api/watchlist').set(authHeader(TEST_USER_ID));
    const tcs = res.body.items.find((i: any) => i.symbol === 'TCS');
    expect(tcs.price).toBeNull();
    expect(tcs.change_percent).toBe(0);
  });

  it('deletes an item (204) then 404 on repeat', async () => {
    await request(app).post('/api/watchlist').set(authHeader(TEST_USER_ID)).send({ symbol: 'RELIANCE' });
    const del = await request(app).delete('/api/watchlist/RELIANCE').set(authHeader(TEST_USER_ID));
    expect(del.status).toBe(204);
    const again = await request(app).delete('/api/watchlist/RELIANCE').set(authHeader(TEST_USER_ID));
    expect(again.status).toBe(404);
  });
});

describe('playlists', () => {
  async function createPlaylist(name: string, user = TEST_USER_ID) {
    return request(app).post('/api/watchlist/playlists').set(authHeader(user)).send({ name });
  }

  it('creates a playlist (201) and lists with item_count', async () => {
    const res = await createPlaylist('Momentum');
    expect(res.status).toBe(201);
    expect(res.body.playlist.name).toBe('Momentum');
    expect(res.body.playlist.item_count).toBe(0);

    const list = await request(app).get('/api/watchlist/playlists').set(authHeader(TEST_USER_ID));
    expect(list.status).toBe(200);
    expect(list.body.playlists).toHaveLength(1);
    expect(list.body.playlists[0]).toMatchObject({ name: 'Momentum', item_count: 0 });
    expect(list.body.playlists[0].created_at).toBeUndefined();
  });

  it('rejects duplicate playlist names (409)', async () => {
    await createPlaylist('Tech');
    const dup = await createPlaylist('tech'); // case-insensitive via LOWER(name)
    expect(dup.status).toBe(409);
  });

  it('renames (200), 409 on duplicate, 404 on foreign id', async () => {
    const created = await createPlaylist('Old Name');
    const id = created.body.playlist.id;

    const rename = await request(app)
      .patch(`/api/watchlist/playlists/${id}`)
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'New Name' });
    expect(rename.status).toBe(200);
    expect(rename.body.playlist.name).toBe('New Name');

    const other = await createPlaylist('Other');
    const dup = await request(app)
      .patch(`/api/watchlist/playlists/${id}`)
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'Other' });
    expect(dup.status).toBe(409);

    const foreign = await request(app)
      .patch(`/api/watchlist/playlists/${id}`)
      .set(authHeader(TEST_USER2_ID))
      .send({ name: 'Hijack' });
    expect(foreign.status).toBe(404);
  });

  it('deletes a playlist (204), 404 on foreign id', async () => {
    const created = await createPlaylist('Delete Me');
    const id = created.body.playlist.id;
    const del = await request(app).delete(`/api/watchlist/playlists/${id}`).set(authHeader(TEST_USER_ID));
    expect(del.status).toBe(204);
    const again = await request(app).delete(`/api/watchlist/playlists/${id}`).set(authHeader(TEST_USER_ID));
    expect(again.status).toBe(404);
  });

  it('reorders playlists', async () => {
    const a = (await createPlaylist('A')).body.playlist.id;
    const b = (await createPlaylist('B')).body.playlist.id;
    const c = (await createPlaylist('C')).body.playlist.id;

    const reorder = await request(app)
      .patch('/api/watchlist/playlists/reorder')
      .set(authHeader(TEST_USER_ID))
      .send({ order: [c, a, b] });
    expect(reorder.status).toBe(200);

    const list = await request(app).get('/api/watchlist/playlists').set(authHeader(TEST_USER_ID));
    expect(list.body.playlists.map((p: any) => p.id)).toEqual([c, a, b]);
  });
});

describe('playlist items', () => {
  async function createPlaylistWithItem(): Promise<{ playlistId: string }> {
    const created = await request(app)
      .post('/api/watchlist/playlists')
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'Tech' });
    const playlistId = created.body.playlist.id;
    await request(app)
      .post(`/api/watchlist/playlists/${playlistId}/items`)
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'RELIANCE' });
    return { playlistId };
  }

  it('adds an item and auto-adds to the watchlist', async () => {
    const { playlistId } = await createPlaylistWithItem();

    const watchlist = await request(app).get('/api/watchlist').set(authHeader(TEST_USER_ID));
    expect(watchlist.body.items.map((i: any) => i.symbol)).toContain('RELIANCE');

    const items = await request(app)
      .get(`/api/watchlist/playlists/${playlistId}/items`)
      .set(authHeader(TEST_USER_ID));
    expect(items.status).toBe(200);
    expect(items.body.items).toHaveLength(1);
    expect(items.body.items[0].symbol).toBe('RELIANCE');
  });

  it('removes from playlist only, leaving the watchlist intact', async () => {
    const { playlistId } = await createPlaylistWithItem();

    const del = await request(app)
      .delete(`/api/watchlist/playlists/${playlistId}/items/RELIANCE`)
      .set(authHeader(TEST_USER_ID));
    expect(del.status).toBe(204);

    const watchlist = await request(app).get('/api/watchlist').set(authHeader(TEST_USER_ID));
    expect(watchlist.body.items.map((i: any) => i.symbol)).toContain('RELIANCE');

    const again = await request(app)
      .delete(`/api/watchlist/playlists/${playlistId}/items/RELIANCE`)
      .set(authHeader(TEST_USER_ID));
    expect(again.status).toBe(404);
  });

  it('reorders items within a playlist', async () => {
    const { playlistId } = await createPlaylistWithItem();
    await request(app)
      .post(`/api/watchlist/playlists/${playlistId}/items`)
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'INFY' });

    const reorder = await request(app)
      .patch(`/api/watchlist/playlists/${playlistId}/items/reorder`)
      .set(authHeader(TEST_USER_ID))
      .send({ order: ['INFY', 'RELIANCE'] });
    expect(reorder.status).toBe(200);

    const items = await request(app)
      .get(`/api/watchlist/playlists/${playlistId}/items`)
      .set(authHeader(TEST_USER_ID));
    expect(items.body.items.map((i: any) => i.symbol)).toEqual(['INFY', 'RELIANCE']);
  });

  it('cascades: deleting a watchlist item removes it from all playlists', async () => {
    const { playlistId } = await createPlaylistWithItem();

    await request(app).delete('/api/watchlist/RELIANCE').set(authHeader(TEST_USER_ID));

    const items = await request(app)
      .get(`/api/watchlist/playlists/${playlistId}/items`)
      .set(authHeader(TEST_USER_ID));
    expect(items.body.items).toHaveLength(0);
  });

  it('cascades: deleting a playlist preserves watchlist items', async () => {
    const { playlistId } = await createPlaylistWithItem();

    await request(app).delete(`/api/watchlist/playlists/${playlistId}`).set(authHeader(TEST_USER_ID));

    const watchlist = await request(app).get('/api/watchlist').set(authHeader(TEST_USER_ID));
    expect(watchlist.body.items.map((i: any) => i.symbol)).toContain('RELIANCE');
  });
});

describe('playlist memberships', () => {
  it('returns symbol -> playlist ids for the user watchlist', async () => {
    const tech = await request(app)
      .post('/api/watchlist/playlists')
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'Tech' });
    const techId = tech.body.playlist.id;

    const long = await request(app)
      .post('/api/watchlist/playlists')
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'Long-term' });
    const longId = long.body.playlist.id;

    await request(app)
      .post(`/api/watchlist/playlists/${techId}/items`)
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'RELIANCE' });
    await request(app)
      .post(`/api/watchlist/playlists/${longId}/items`)
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'RELIANCE' });
    await request(app)
      .post(`/api/watchlist/playlists/${techId}/items`)
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'INFY' });

    const res = await request(app)
      .get('/api/watchlist/playlists/memberships')
      .set(authHeader(TEST_USER_ID));
    expect(res.status).toBe(200);
    expect(res.body.memberships.RELIANCE.sort()).toEqual([techId, longId].sort());
    expect(res.body.memberships.INFY).toEqual([techId]);
  });

  it('is scoped per user', async () => {
    await request(app)
      .post('/api/watchlist/playlists')
      .set(authHeader(TEST_USER_ID))
      .send({ name: 'Only Mine' });
    await request(app)
      .post('/api/watchlist')
      .set(authHeader(TEST_USER_ID))
      .send({ symbol: 'RELIANCE' });

    const mine = await request(app)
      .get('/api/watchlist/playlists/memberships')
      .set(authHeader(TEST_USER_ID));
    const theirs = await request(app)
      .get('/api/watchlist/playlists/memberships')
      .set(authHeader(TEST_USER2_ID));
    expect(mine.body.memberships).toHaveProperty('RELIANCE');
    expect(theirs.body.memberships).toEqual({});
  });
});
