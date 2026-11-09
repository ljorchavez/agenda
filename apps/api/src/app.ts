import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { sendDueReminders } from './jobs/reminders.js';
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
import { tableRoutes } from './routes/tables.js';
import { professionalRoutes } from './routes/professionals.js';
import { spaceRoutes } from './routes/spaces.js';
import { classRoutes } from './routes/classes.js';
import { webhookRoutes } from './routes/webhooks.js';

export function createApp() {
  const app = new Hono().basePath('/api');

  app.use('*', secureHeaders());
  if (process.env.NODE_ENV !== 'test') app.use('*', logger());
  // In AWS the web app and API share a domain through CloudFront, so CORS is only for local dev.
  app.use('*', cors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',') }));
  app.onError(errorHandler);

  app.get('/health', (c) => c.json({ ok: true }));

  // Scheduled job endpoint (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
  app.get('/cron/reminders', async (c) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json(await sendDueReminders());
  });

  // Public (no auth)
  app.route('/', directoryRoutes);
  app.route('/', manageRoutes);
  app.route('/', publicRoutes);
  app.route('/', webhookRoutes);
  app.route('/', authRoutes); // register/login are public; the rest apply requireAuth per route

  // Authenticated, tenant-scoped
  const priv = new Hono<AppEnv>();
  // Auth on explicit prefixes so unknown paths still return 404 instead of 401.
  for (const prefix of ['/customers', '/services', '/appointments', '/payments', '/metrics', '/reports', '/tables', '/professionals', '/spaces', '/class-sessions']) {
    priv.use(prefix, requireAuth);
    priv.use(`${prefix}/*`, requireAuth);
  }
  priv.route('/', customerRoutes);
  priv.route('/', serviceRoutes);
  priv.route('/', appointmentRoutes);
  priv.route('/', paymentRoutes);
  priv.route('/', metricsRoutes);
  priv.route('/', reportRoutes);
  priv.route('/', tableRoutes);
  priv.route('/', professionalRoutes);
  priv.route('/', spaceRoutes);
  priv.route('/', classRoutes);
  app.route('/', priv);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
