-- Watchlist + playlists: users track stocks and organize them into named playlists.
-- A stock can belong to multiple playlists (many-to-many via watchlist_playlist_items).
-- "All" is a virtual view (SELECT * FROM watchlist_items WHERE user_id = $1), not a stored row.

CREATE TABLE IF NOT EXISTS watchlist_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_items_user_symbol
  ON watchlist_items (user_id, UPPER(symbol));
CREATE INDEX IF NOT EXISTS idx_watchlist_items_user_id
  ON watchlist_items (user_id);

CREATE TABLE IF NOT EXISTS watchlist_playlists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_playlists_user_name
  ON watchlist_playlists (user_id, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_watchlist_playlists_user_id
  ON watchlist_playlists (user_id, position);

CREATE TABLE IF NOT EXISTS watchlist_playlist_items (
  playlist_id       UUID NOT NULL REFERENCES watchlist_playlists(id) ON DELETE CASCADE,
  watchlist_item_id UUID NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, watchlist_item_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_playlist_items_playlist
  ON watchlist_playlist_items (playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_watchlist_playlist_items_item
  ON watchlist_playlist_items (watchlist_item_id);
