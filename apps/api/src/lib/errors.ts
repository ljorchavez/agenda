import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = 'resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message?: string) => new AppError(409, code, message);

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: err.code, message: err.message, details: err.details }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: 'validation_error', details: err.flatten() }, 422);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: 'http_error', message: err.message }, err.status);
  }
  console.error('Unhandled error', err);
  return c.json({ error: 'internal_error' }, 500);
}
