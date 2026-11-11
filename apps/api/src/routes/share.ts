import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { pageSettingsOf } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { tenants } from '../db/schema.js';

/**
 * Link previews: /b/<slug> is routed here (scripts/vercel-build.sh) so WhatsApp, Facebook and
 * others see the business name, description and banner. People get the same app page.
 */
export const shareRoutes = new Hono();

const FALLBACK = '<!doctype html><html lang="es"><head><meta charset="UTF-8" /><!--og--><!--/og--><title>Agenda</title></head><body><div id="root"></div></body></html>';
let cached: string | null = null;
function appHtml(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = [join(here, 'app.html'), join(here, '../../../web/dist/index.html')].find((f) => existsSync(f));
    cached = file ? readFileSync(file, 'utf8') : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

shareRoutes.get('/page/b/:slug', async (c) => {
  const html = appHtml();
  const t = await getDb().query.tenants.findFirst({ where: eq(tenants.slug, c.req.param('slug')) });
  const origin = new URL(c.req.url).origin.replace(/^http:\/\/(?!localhost)/, 'https://');
  const base = (process.env.APP_URL ?? origin).replace(/\/$/, '');
  if (!t || !t.settings.onlineBookingEnabled) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html);
  }
  const page = pageSettingsOf(t.settings);
  const image = page.bannerUrl ?? page.gallery[0] ?? page.logoUrl ?? `${base}/icons/icon-512.png`;
  const where = [t.neighborhood, t.city].filter(Boolean).join(', ');
  const title = where ? `${t.name} · ${where}` : t.name;
  const description = (t.description?.trim() || 'Reserva en línea en segundos.').slice(0, 200);
  const url = `${base}/b/${t.slug}`;
  const tags = [
    `<meta property="og:site_name" content="Agenda" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="description" content="${esc(description)}" />`,
  ].join('\n    ');
  const out = html
    .replace(/<!--og-->[\s\S]*<!--\/og-->/, `<!--og-->\n    ${tags}\n    <!--/og-->`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(t.name)} · Reserva en línea</title>`);
  c.header('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  return c.html(out);
});
