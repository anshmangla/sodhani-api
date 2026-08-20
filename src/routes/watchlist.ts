import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../auth/middleware';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Shared LATERAL block resolving the latest trading-day snapshot for a stock,
// identical to the one used by /api/quote. Computes:
//   price = latest close, change = close - open, change_percent vs open.
const PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      MAX(record_date) AS true_date,
      (array_agg(open_price ORDER BY record_date ASC))[1] AS true_open,
      (array_agg(close_price ORDER BY record_date DESC))[1] AS true_close
    FROM historical_prices hp
    WHERE hp."FinInstrmId" = cs."FinInstrmId"
      AND DATE(hp.record_date) = (
        SELECT MAX(DATE(record_date))
        FROM historical_prices
        WHERE "FinInstrmId" = cs."FinInstrmId"
      )
  ) hp_latest ON true`;

function mapPriceRow(row: any) {
  const price = row.price;
  const change = row.change;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    price,
    change,
    change_percent: row.change_percent,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

async function stockExists(symbol: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM company_stock WHERE UPPER("TckrSymb") = UPPER($1)',
    [symbol]
  );
  return result.rows.length > 0;
}

async function playlistBelongsToUser(playlistId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM watchlist_playlists WHERE id = $1 AND user_id = $2',
    [playlistId, userId]
  );
  return result.rows.length > 0;
}

// GET /api/watchlist - all watchlist items with server-side joined live prices.
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT wi.id, UPPER(cs."TckrSymb") AS symbol, cs."FinInstrmNm" AS name,
            hp_latest."true_close" AS price,
            (hp_latest."true_close"::float - hp_latest."true_open"::float) AS change,
            CASE WHEN hp_latest."true_open"::float > 0
              THEN ((hp_latest."true_close"::float - hp_latest."true_open"::float) / hp_latest."true_open"::float) * 100
              ELSE 0
            END AS change_percent,
            wi.created_at
     FROM watchlist_items wi
     JOIN company_stock cs ON UPPER(cs."TckrSymb") = UPPER(wi.symbol)
     ${PRICE_LATERAL}
     WHERE wi.user_id = $1
     ORDER BY wi.created_at DESC`,
    [req.authUserId]
  );
  res.status(200).json({ items: result.rows.map(mapPriceRow) });
}));

// POST /api/watchlist - add a stock to the watchlist. Idempotent: returns 201 on
// insert, 200 if the stock was already present.
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { symbol } = req.body ?? {};
  if (typeof symbol !== 'string' || symbol.trim().length === 0) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const normalized = symbol.trim().toUpperCase();
  if (!(await stockExists(normalized))) {
    res.status(404).json({ error: `No stock found for symbol '${normalized}'` });
    return;
  }
  const result = await pool.query(
    `INSERT INTO watchlist_items (user_id, symbol)
     VALUES ($1, $2)
     ON CONFLICT (user_id, UPPER(symbol)) DO NOTHING`,
    [req.authUserId, normalized]
  );
  res.status(result.rowCount === 0 ? 200 : 201).json({ symbol: normalized });
}));

// DELETE /api/watchlist/:symbol - remove a stock from the watchlist (cascades out of all playlists).
router.delete('/:symbol', requireAuth, asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const result = await pool.query(
    `DELETE FROM watchlist_items WHERE user_id = $1 AND UPPER(symbol) = UPPER($2)`,
    [req.authUserId, symbol]
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: `'${symbol}' is not in the watchlist` });
    return;
  }
  res.status(204).end();
}));

// GET /api/watchlist/playlists - list the user's playlists with item counts.
router.get('/playlists', requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.position, p.created_at, p.updated_at,
            COUNT(wpi.watchlist_item_id)::int AS item_count
     FROM watchlist_playlists p
     LEFT JOIN watchlist_playlist_items wpi ON wpi.playlist_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.position ASC, p.created_at ASC`,
    [req.authUserId]
  );
  res.status(200).json({ playlists: result.rows });
}));

// POST /api/watchlist/playlists - create a playlist. 409 on duplicate name.
router.post('/playlists', requireAuth, asyncHandler(async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const trimmed = name.trim();
  try {
    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM watchlist_playlists WHERE user_id = $1',
      [req.authUserId]
    );
    const position = posResult.rows[0].next_position;
    const result = await pool.query(
      `INSERT INTO watchlist_playlists (user_id, name, position)
       VALUES ($1, $2, $3)
       RETURNING id, name, position, created_at`,
      [req.authUserId, trimmed, position]
    );
    const row = result.rows[0];
    res.status(201).json({ playlist: { id: row.id, name: row.name, position: row.position, item_count: 0 } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A playlist named '${trimmed}' already exists` });
      return;
    }
    throw err;
  }
}));

// PATCH /api/watchlist/playlists/reorder - set playlist order. Must be registered
// before /playlists/:id so "reorder" isn't captured as an id.
router.patch('/playlists/reorder', requireAuth, asyncHandler(async (req, res) => {
  const { order } = req.body ?? {};
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'order must be an array of playlist ids' });
    return;
  }
  const ids = order as string[];
  const owned = await pool.query(
    'SELECT id FROM watchlist_playlists WHERE user_id = $1 AND id = ANY($2)',
    [req.authUserId, ids]
  );
  if (owned.rows.length !== ids.length) {
    res.status(404).json({ error: 'One or more playlists do not belong to the user' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        'UPDATE watchlist_playlists SET position = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
        [i, ids[i], req.authUserId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(200).json({ playlists: ids });
}));

// PATCH /api/watchlist/playlists/:id - rename a playlist. 409 on duplicate name.
router.patch('/playlists/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const trimmed = name.trim();
  if (!(await playlistBelongsToUser(id, req.authUserId!))) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE watchlist_playlists SET name = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING id, name, position`,
      [trimmed, id, req.authUserId]
    );
    res.status(200).json({ playlist: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A playlist named '${trimmed}' already exists` });
      return;
    }
    throw err;
  }
}));

// DELETE /api/watchlist/playlists/:id - delete a playlist. Watchlist items are preserved.
router.delete('/playlists/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    'DELETE FROM watchlist_playlists WHERE id = $1 AND user_id = $2',
    [id, req.authUserId]
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  res.status(204).end();
}));

// GET /api/watchlist/playlists/:id/items - items in a playlist with live prices.
router.get('/playlists/:id/items', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!(await playlistBelongsToUser(id, req.authUserId!))) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  const result = await pool.query(
    `SELECT wi.id, UPPER(cs."TckrSymb") AS symbol, cs."FinInstrmNm" AS name,
            hp_latest."true_close" AS price,
            (hp_latest."true_close"::float - hp_latest."true_open"::float) AS change,
            CASE WHEN hp_latest."true_open"::float > 0
              THEN ((hp_latest."true_close"::float - hp_latest."true_open"::float) / hp_latest."true_open"::float) * 100
              ELSE 0
            END AS change_percent,
            wpi.position,
            wi.created_at
     FROM watchlist_playlist_items wpi
     JOIN watchlist_items wi ON wi.id = wpi.watchlist_item_id
     JOIN company_stock cs ON UPPER(cs."TckrSymb") = UPPER(wi.symbol)
     ${PRICE_LATERAL}
     WHERE wpi.playlist_id = $1
     ORDER BY wpi.position ASC, wpi.added_at ASC`,
    [id]
  );
  res.status(200).json({ items: result.rows.map(mapPriceRow) });
}));

// POST /api/watchlist/playlists/:id/items - add a stock to a playlist. Auto-adds to
// the watchlist if not already present. Idempotent.
router.post('/playlists/:id/items', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { symbol } = req.body ?? {};
  if (typeof symbol !== 'string' || symbol.trim().length === 0) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const normalized = symbol.trim().toUpperCase();
  if (!(await playlistBelongsToUser(id, req.authUserId!))) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (!(await stockExists(normalized))) {
    res.status(404).json({ error: `No stock found for symbol '${normalized}'` });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemResult = await client.query(
      `INSERT INTO watchlist_items (user_id, symbol)
       VALUES ($1, $2)
       ON CONFLICT (user_id, UPPER(symbol)) DO NOTHING
       RETURNING id`,
      [req.authUserId, normalized]
    );
    let itemId = itemResult.rows[0]?.id;
    if (!itemId) {
      const existing = await client.query(
        'SELECT id FROM watchlist_items WHERE user_id = $1 AND UPPER(symbol) = UPPER($2)',
        [req.authUserId, normalized]
      );
      itemId = existing.rows[0].id;
    }
    const posResult = await client.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM watchlist_playlist_items WHERE playlist_id = $1',
      [id]
    );
    const position = posResult.rows[0].next_position;
    await client.query(
      `INSERT INTO watchlist_playlist_items (playlist_id, watchlist_item_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, watchlist_item_id) DO NOTHING`,
      [id, itemId, position]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(200).json({ symbol: normalized, playlist_id: id });
}));

// DELETE /api/watchlist/playlists/:id/items/:symbol - remove a stock from a playlist
// only; the stock remains in the watchlist. 404 if not in the playlist.
router.delete('/playlists/:id/items/:symbol', requireAuth, asyncHandler(async (req, res) => {
  const { id, symbol } = req.params;
  if (!(await playlistBelongsToUser(id, req.authUserId!))) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  const result = await pool.query(
    `DELETE FROM watchlist_playlist_items wpi
     USING watchlist_items wi
     WHERE wpi.playlist_id = $1
       AND wpi.watchlist_item_id = wi.id
       AND wi.user_id = $2
       AND UPPER(wi.symbol) = UPPER($3)`,
    [id, req.authUserId, symbol]
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: `'${symbol}' is not in this playlist` });
    return;
  }
  res.status(204).end();
}));

// PATCH /api/watchlist/playlists/:id/items/reorder - set item order within a playlist.
// Must be registered before /playlists/:id/items/:symbol.
router.patch('/playlists/:id/items/reorder', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { order } = req.body ?? {};
  if (!Array.isArray(order) || order.some((s) => typeof s !== 'string')) {
    res.status(400).json({ error: 'order must be an array of symbols' });
    return;
  }
  if (!(await playlistBelongsToUser(id, req.authUserId!))) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  const symbols = order as string[];
  const owned = await pool.query(
    `SELECT wi.symbol FROM watchlist_playlist_items wpi
     JOIN watchlist_items wi ON wi.id = wpi.watchlist_item_id
     WHERE wpi.playlist_id = $1 AND wi.user_id = $2 AND UPPER(wi.symbol) = ANY($3)`,
    [id, req.authUserId, symbols.map((s) => s.toUpperCase())]
  );
  if (owned.rows.length !== symbols.length) {
    res.status(404).json({ error: 'One or more symbols are not in this playlist' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < symbols.length; i++) {
      await client.query(
        `UPDATE watchlist_playlist_items wpi
         SET position = $1
         FROM watchlist_items wi
         WHERE wpi.playlist_id = $2
           AND wpi.watchlist_item_id = wi.id
           AND UPPER(wi.symbol) = UPPER($3)`,
        [i, id, symbols[i]]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(200).json({ symbols });
}));

export default router;
