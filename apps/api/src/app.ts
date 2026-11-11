import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { seedDemo } from './db/demo-data.js';
import { sendDueReminders } from './jobs/reminders.js';
import { portalRoutes } from './routes/portal.js';
import { isRemindersWorkflow } from './lib/github-oidc.js';
import { errorHandler } from './lib/errors.js';
import { requireAuth, type AppEnv } from './middleware/auth.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { customerRoutes } from './routes/customers.js';
import { directoryRoutes } from './routes/directory.js';
import { manageRoutes } from './routes/manage.js';
import { metricsRoutes } from './routes/metrics.js';
import { paymentRoutes } from './routes/payments.js';
import { publicRoutes } from './routes/public.js';
import { reportRoutes } from './routes/reports.js';
import { serviceRoutes } from './routes/services.js';
import { resourceRoutes } from './routes/resources.js';
import { classRoutes } from './routes/classes.js';
import { locationRoutes } from './routes/locations.js';
import { webhookRoutes } from './routes/webhooks.js';
import { passwordRoutes } from './routes/password.js';
import { blockRoutes } from './routes/blocks.js';
import { couponRoutes } from './routes/coupons.js';
import { uploadRoutes } from './routes/uploads.js';
import { saleRoutes } from './routes/sales.js';
import { formRoutes } from './routes/forms.js';
import { clinicalRoutes } from './routes/clinical.js';
import { invoicingRoutes } from './routes/invoicing.js';
import { shareRoutes } from './routes/share.js';
import { shopRoutes } from './routes/shop.js';
import { recordRoutes } from './routes/records.js';
import { cashRoutes } from './routes/cash.js';
import { publicReviewRoutes, reviewRoutes } from './routes/reviews.js';
import { calendarRoutes, publicCalendarRoutes } from './routes/calendar.js';
import { pruneAuthTables } from './lib/throttle.js';
import { getDb } from './db/client.js';

export function createApp() {
  const app = new Hono().basePath('/api');

  app.use('*', secureHeaders());
  if (process.env.NODE_ENV !== 'test') app.use('*', logger());
  // In AWS the web app and API share a domain through CloudFront, so CORS is only for local dev.
  app.use('*', cors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',') }));
  app.onError(errorHandler);

  app.get('/health', (c) => c.json({ ok: true }));

  // Scheduled job endpoints (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
  const isCron = (auth: string | undefined) => {
    const secret = process.env.CRON_SECRET;
    return !!secret && auth === `Bearer ${secret}`;
  };
  // Every 15 minutes from GitHub Actions (OIDC token, no shared secret) and daily from Vercel
  // (CRON_SECRET), so each reminder goes out at the hours before the appointment the business chose.
  app.get('/cron/reminders', async (c) => {
    const auth = c.req.header('authorization');
    if (!isCron(auth) && !(await isRemindersWorkflow(auth))) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await sendDueReminders(200, 0));
  });
  // Nightly reset of the demo businesses so the demo always has upcoming appointments.
  app.get('/cron/reset-demo', async (c) => {
    if (!isCron(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    const started = Date.now();
    await seedDemo();
    await pruneAuthTables(getDb());
    return c.json({ ok: true, ms: Date.now() - started });
  });

  // Public (no auth)
  app.route('/', directoryRoutes);
  app.route('/', manageRoutes);
  // Before publicRoutes: /public/portal and /public/prescriptions would match /public/:slug
  app.route('/', portalRoutes);
  app.route('/', publicRoutes);
  app.route('/', webhookRoutes);
  app.route('/', publicReviewRoutes);
  app.route('/', publicCalendarRoutes);
  app.route('/', shareRoutes);
  app.route('/', shopRoutes);
  app.route('/', passwordRoutes);
  app.route('/', authRoutes); // register/login are public; the rest apply requireAuth per route

  // Authenticated, tenant-scoped
  const priv = new Hono<AppEnv>();
  // Auth on explicit prefixes so unknown paths still return 404 instead of 401.
  for (const prefix of ['/customers', '/services', '/appointments', '/payments', '/metrics', '/reports', '/resources', '/class-sessions', '/locations', '/time-blocks', '/uploads', '/collections', '/coupons', '/offerings', '/customer-plans', '/gift-cards', '/cash', '/record-notes', '/record-photos', '/reviews', '/calendar-feeds', '/forms', '/clinical-notes', '/studies', '/invoicing', '/invoices']) {
    priv.use(prefix, requireAuth);
    priv.use(`${prefix}/*`, requireAuth);
  }
  priv.route('/', customerRoutes);
  priv.route('/', serviceRoutes);
  priv.route('/', appointmentRoutes);
  priv.route('/', paymentRoutes);
  priv.route('/', metricsRoutes);
  priv.route('/', reportRoutes);
  priv.route('/', resourceRoutes);
  priv.route('/', classRoutes);
  priv.route('/', locationRoutes);
  priv.route('/', blockRoutes);
  priv.route('/', couponRoutes);
  priv.route('/', uploadRoutes);
  priv.route('/', saleRoutes);
  priv.route('/', recordRoutes);
  priv.route('/', cashRoutes);
  priv.route('/', reviewRoutes);
  priv.route('/', calendarRoutes);
  priv.route('/', formRoutes);
  priv.route('/', clinicalRoutes);
  priv.route('/', invoicingRoutes);
  app.route('/', priv);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
