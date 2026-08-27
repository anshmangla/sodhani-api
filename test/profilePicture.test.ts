import { existsSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app } from '../src/app';
import { raAuthHeader, authHeader, clearProfilePictures, closeTestPool } from './helpers';
import { TEST_RA_ID, TEST_USER_ID } from './constants';

beforeEach(clearProfilePictures);
afterAll(closeTestPool);

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function uploadsDir(): string {
  return join(__dirname, '..', 'uploads', 'profile-pictures');
}

describe('RA profile picture upload', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/api/ra/profile-picture')
      .attach('picture', TINY_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('rejects a request with no file (400)', async () => {
    const res = await request(app).post('/api/ra/profile-picture').set(raAuthHeader(TEST_RA_ID));
    expect(res.status).toBe(400);
  });

  it('rejects a non-image file (400)', async () => {
    const res = await request(app)
      .post('/api/ra/profile-picture')
      .set(raAuthHeader(TEST_RA_ID))
      .attach('picture', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('rejects a file over 2MB (400)', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const res = await request(app)
      .post('/api/ra/profile-picture')
      .set(raAuthHeader(TEST_RA_ID))
      .attach('picture', big, { filename: 'huge.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });

  it('saves the file, updates profile_picture_url, and replaces the old file on re-upload', async () => {
    const first = await request(app)
      .post('/api/ra/profile-picture')
      .set(raAuthHeader(TEST_RA_ID))
      .attach('picture', TINY_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(first.status).toBe(200);
    const firstUrl: string = first.body.ra.profile_picture_url;
    expect(firstUrl).toMatch(/^\/uploads\/profile-pictures\/.+\.jpg$/);
    const firstFilePath = join(uploadsDir(), firstUrl.split('/').pop()!);
    expect(existsSync(firstFilePath)).toBe(true);

    const second = await request(app)
      .post('/api/ra/profile-picture')
      .set(raAuthHeader(TEST_RA_ID))
      .attach('picture', TINY_JPEG, { filename: 'avatar2.png', contentType: 'image/png' });
    expect(second.status).toBe(200);
    const secondUrl: string = second.body.ra.profile_picture_url;
    expect(secondUrl).not.toBe(firstUrl);
    expect(existsSync(firstFilePath)).toBe(false);

    const me = await request(app).get('/api/ra/me').set(raAuthHeader(TEST_RA_ID));
    expect(me.body.ra.profile_picture_url).toBe(secondUrl);
  });
});

describe('user profile picture upload', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/api/auth/profile-picture')
      .attach('picture', TINY_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('saves the file and updates profile_picture_url', async () => {
    const res = await request(app)
      .post('/api/auth/profile-picture')
      .set(authHeader(TEST_USER_ID))
      .attach('picture', TINY_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.user.profile_picture_url).toMatch(/^\/uploads\/profile-pictures\/.+\.jpg$/);

    const me = await request(app).get('/api/auth/me').set(authHeader(TEST_USER_ID));
    expect(me.body.user.profile_picture_url).toBe(res.body.user.profile_picture_url);
  });
});
