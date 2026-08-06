import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../auth/middleware';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// GET /api/me/calls
router.get('/calls', requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT rc.*, ra.full_name AS ra_name, ra.profile_picture_url AS ra_profile_picture_url,
            ra.designation AS ra_designation, pc.purchased_at
     FROM purchased_calls pc
     JOIN research_calls rc ON rc.id = pc.call_id
     JOIN research_analysts ra ON ra.id = rc.ra_id
     WHERE pc.user_id = $1
     ORDER BY pc.purchased_at DESC`,
    [req.authUserId]
  );

  res.status(200).json({ calls: result.rows });
}));

// GET /api/me/calls/:id/comments
router.get('/calls/:id/comments', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const purchasedResult = await pool.query(
    'SELECT 1 FROM purchased_calls WHERE user_id = $1 AND call_id = $2',
    [req.authUserId, id]
  );
  if (purchasedResult.rows.length === 0) {
    res.status(403).json({ error: 'Purchase required' });
    return;
  }

  const commentsResult = await pool.query(
    'SELECT id, body, created_at FROM call_comments WHERE call_id = $1 ORDER BY created_at ASC',
    [id]
  );

  res.status(200).json({ comments: commentsResult.rows });
}));

export default router;
