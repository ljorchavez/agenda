import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { put } from '@vercel/blob';
import { AppError } from '../lib/errors.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Photo uploads (team, courts, services) to Vercel Blob. The browser shrinks the picture first,
 * so 2 MB is plenty. Returns the public https URL to save in `photoUrl`.
 * Env: BLOB_READ_WRITE_TOKEN (added by connecting a Blob store to the Vercel project).
 */
export const uploadRoutes = new Hono<AppEnv>();

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

uploadRoutes.post('/uploads/photo', requireManager, async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) throw new AppError(422, 'validation_error', 'Send the picture in the "file" field');
  const ext = TYPES[file.type];
  if (!ext) throw new AppError(422, 'unsupported_image', 'Use a JPG, PNG or WebP picture');
  if (file.size > MAX_BYTES) throw new AppError(422, 'image_too_large', 'The picture is larger than 2 MB');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new AppError(502, 'uploads_not_configured', 'Photo storage is not set up yet');

  const blob = await put(`photos/${c.get('tenantId')}/${randomUUID()}.${ext}`, file, {
    access: 'public',
    contentType: file.type,
    cacheControlMaxAge: 60 * 60 * 24 * 365,
  });
  return c.json({ url: blob.url }, 201);
});
