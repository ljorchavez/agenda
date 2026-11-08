// Vercel Function entry (Node.js runtime). Bundled by `pnpm --filter @agenda/api build:vercel`
// into .vercel/output/functions/api.func (see scripts/vercel-build.sh).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from '@hono/node-server/vercel';
import { createApp } from './app.js';

const handler = handle(createApp());

export default function vercelHandler(req: IncomingMessage, res: ServerResponse) {
  // All /api/* requests are routed to this single function with the original
  // sub-path in `__path` (see config.json routes). Restore the real URL for Hono.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = `/api/${original}${qs ? `?${qs}` : ''}`;
  }
  return handler(req, res);
}
