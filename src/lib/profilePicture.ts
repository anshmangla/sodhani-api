import { unlink } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';

const UPLOAD_DIR = join(process.cwd(), 'uploads', 'profile-pictures');
mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Auth middleware runs before this in the route chain, so req.authRaId /
// req.authUserId is already set when multer picks the destination filename.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ownerId = req.authRaId ?? req.authUserId ?? 'unknown';
    const ext = EXT_BY_MIME[file.mimetype];
    cb(null, `${ownerId}-${Date.now()}${ext}`);
  },
});

export const profilePictureUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!EXT_BY_MIME[file.mimetype]) {
      cb(new Error('Only JPEG, PNG, and WEBP images are allowed'));
      return;
    }
    cb(null, true);
  },
}).single('picture');

// Placed after profilePictureUpload in the route chain: Express routes an
// error passed to next() straight to the next 4-arg handler, skipping
// asyncHandler(...) in between, so this is what turns a rejected upload into
// a 400 instead of falling through to the generic 500 handler in app.ts.
export function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof MulterError) {
    const detail = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 2MB' : err.message;
    res.status(400).json({ detail });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ detail: err.message });
    return;
  }
  next(err);
}

export function profilePictureUrlForFile(filename: string): string {
  return `/uploads/profile-pictures/${filename}`;
}

// Best-effort cleanup of the previous picture; a missing file (already
// deleted, or a URL from before this feature existed) is not an error.
export async function deleteOldProfilePicture(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const filename = url.split('/').pop();
  if (!filename) return;
  const filePath = join(UPLOAD_DIR, filename);
  if (!existsSync(filePath)) return;
  try {
    await unlink(filePath);
  } catch (err) {
    console.error('[profilePicture] Failed to delete old file:', err);
  }
}
