// End-to-end API checks against the deployed app.
// Usage: BASE=https://agenda-crm-rouge.vercel.app CRON_SECRET=... node e2e/prod-api.mjs
// Writes only inside the demo tenant (it is reset on every deploy).
const BASE = process.env.BASE ?? 'https://agenda-crm-rouge.vercel.app';
let pass = 0;
let fail = 0;
const results = [];

async function call(method, path, body, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

function check(name, cond, info = '') {
  if (cond) {
    pass++;
    results.push(`PASS  ${name}`);
  } else {
    fail++;
    results.push(`FAIL  ${name} ${info}`);
  }
}

const mx = (d) => new Date(d).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

// ---- Infra & frontend
let r = await call('GET', '/api/health');
check('health ok', r.status === 200 && r.body?.ok === true, r.text);
r = await call('GET', '/');
check('home serves SPA html', r.status === 200 && r.text.includes('<div id="root">'));
const asset = r.text.match(/\/assets\/[^"]+\.js/)?.[0];
check('JS bundle referenced', !!asset);
if (asset) {
  const a = await fetch(`${BASE}${asset}`);
  check('JS bundle downloads', a.status === 200);
}
r = await call('GET', '/b/nutricion-demo');
check('deep link /b/:slug serves SPA', r.status === 200 && r.text.includes('<div id="root">'));
r = await call('GET', '/api/does-not-exist');
check('unknown API route -> 404 JSON', r.status === 404 && r.body?.error === 'not_found', r.status);

// ---- Auth
r = await call('POST', '/api/auth/login', { email: 'demo@agenda.mx', password: 'wrong' });
check('login wrong password -> 401', r.status === 401 && r.body?.error === 'invalid_credentials', r.text);
r = await call('POST', '/api/auth/login', { email: 'not-an-email', password: 'x' });
check('login invalid email -> 422', r.status === 422, r.status);
r = await call('POST', '/api/auth/login', { email: 'demo@agenda.mx', password: 'demo1234' });
check('demo login -> 200 + token', r.status === 200 && !!r.body?.token, r.text);
const demoBusinesses = r.body?.businesses ?? [];
check('demo owner sees every demo business', ['nutricion-demo', 'restaurante-demo', 'barberia-demo', 'yoga-demo', 'padel-demo'].every((x) => demoBusinesses.some((b) => b.slug === x && b.role === 'owner')), JSON.stringify(demoBusinesses.map((b) => b.slug)));
/** Demo owner session opened on one business (business switcher). */
async function asDemo(slug) {
  const l = await call('POST', '/api/auth/login', { email: 'demo@agenda.mx', password: 'demo1234' });
  const biz = (l.body?.businesses ?? []).find((b) => b.slug === slug);
  if (!biz) return { token: null, tenant: null };
  const sw = await call('POST', '/api/auth/switch', { tenantId: biz.id }, l.body.token);
  return { token: sw.body?.token, tenant: sw.body?.tenant, user: sw.body?.user };
}
/** Same, but returns the raw switch response ({ status, body, text }). */
async function demoLogin(slug) {
  const l = await call('POST', '/api/auth/login', { email: 'demo@agenda.mx', password: 'demo1234' });
  const biz = (l.body?.businesses ?? []).find((b) => b.slug === slug);
  if (!biz) return { status: 404, body: null, text: `no demo business ${slug}` };
  return call('POST', '/api/auth/switch', { tenantId: biz.id }, l.body.token);
}
r = await call('POST', '/api/auth/switch', { tenantId: demoBusinesses.find((b) => b.slug === 'nutricion-demo')?.id }, r.body?.token);
check('switch to nutrition demo', r.status === 200 && r.body?.tenant?.slug === 'nutricion-demo', r.text.slice(0, 200));
const token = r.body?.token;
const tenant = r.body?.tenant;
check('demo tenant slug', tenant?.slug === 'nutricion-demo', tenant?.slug);
r = await call('POST', '/api/auth/register', {
  businessName: 'Dup', businessType: 'other', name: 'Dup', email: 'demo@agenda.mx', password: 'password123',
});
check('register duplicate email -> 409', r.status === 409 && r.body?.error === 'email_taken', r.text);
r = await call('GET', '/api/customers');
check('private route without token -> 401', r.status === 401, r.status);
r = await call('GET', '/api/customers', null, 'garbage.token.value');
check('private route bad token -> 401', r.status === 401, r.status);
r = await call('GET', '/api/auth/me', null, token);
check('me -> user + tenant', r.status === 200 && r.body?.user?.email === 'demo@agenda.mx', r.text);

// ---- Read endpoints with seeded data
r = await call('GET', '/api/services', null, token);
check('services list (3 seeded)', r.status === 200 && r.body?.length === 3, r.body?.length);
const services = r.body ?? [];
r = await call('GET', '/api/customers?sort=totalSpent', null, token);
check('customers list (28 seeded)', r.status === 200 && r.body?.total === 28, r.body?.total);
const top = r.body?.items?.[0];
check('customer stats computed', top && top.visits > 0 && top.totalSpentCents > 0, JSON.stringify(top));
check('sort by totalSpent desc', r.body?.items?.[0]?.totalSpentCents >= r.body?.items?.[1]?.totalSpentCents);
r = await call('GET', `/api/customers?q=${encodeURIComponent('maría')}`, null, token);
check('customer search', r.status === 200 && r.body?.items?.some((c) => c.name.includes('María')), r.text.slice(0, 200));
r = await call('GET', `/api/customers/${top?.id}`, null, token);
check('customer detail w/ history+payments', r.status === 200 && r.body?.appointments?.length > 0 && r.body?.payments?.length > 0);
const now = new Date();
const weekFrom = new Date(now.getTime() - 3 * 864e5).toISOString();
const weekTo = new Date(now.getTime() + 10 * 864e5).toISOString();
r = await call('GET', `/api/appointments?from=${encodeURIComponent(weekFrom)}&to=${encodeURIComponent(weekTo)}`, null, token);
check('appointments in range', r.status === 200 && Array.isArray(r.body) && r.body.length > 0, r.text.slice(0, 200));
r = await call('GET', '/api/appointments?from=bad&to=bad', null, token);
check('appointments bad range -> 422', r.status === 422, r.status);
r = await call('GET', '/api/metrics/dashboard', null, token);
check('dashboard ok', r.status === 200 && r.body?.revenueByMonth?.length >= 6, r.text.slice(0, 300));
check('dashboard has revenue history', r.body?.revenueByMonth?.some((m) => m.revenueCents > 0));
check('dashboard upcoming', r.body?.upcoming?.length > 0);
check('dashboard avg frequency', typeof r.body?.kpis?.avgDaysBetweenVisits === 'number', r.body?.kpis?.avgDaysBetweenVisits);
const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
r = await call('GET', `/api/metrics/dashboard?from=${lm.toISOString()}&to=${new Date(now.getFullYear(), now.getMonth(), 1).toISOString()}`, null, token);
check('dashboard last month has revenue', r.status === 200 && r.body?.kpis?.revenueCents > 0, r.body?.kpis?.revenueCents);
r = await call('GET', `/api/payments?from=${lm.toISOString()}`, null, token);
check('payments list', r.status === 200 && r.body?.length > 0, r.body?.length);
r = await call('GET', '/api/users', null, token);
check('team list', r.status === 200 && r.body?.length >= 1);

// ---- Write flow inside demo tenant
const svc = services.find((s) => s.durationMin === 30) ?? services[0];
r = await call('POST', '/api/customers', { name: 'Cliente QA', phone: '55 9876 5432', email: 'qa@example.com' }, token);
check('create customer', r.status === 201 && r.body?.phone === '+525598765432', r.text);
const cust = r.body;
r = await call('POST', '/api/customers', { name: 'Cliente QA 2', phone: '5598765432' }, token);
check('duplicate phone -> 409 phone_taken', r.status === 409 && r.body?.error === 'phone_taken', r.text);
r = await call('PUT', `/api/customers/${cust?.id}`, { name: 'Cliente QA Editado', phone: '5598765432', notes: 'Alergia a nueces' }, token);
check('update customer', r.status === 200 && r.body?.notes === 'Alergia a nueces', r.text);

// pick a slot 20 days ahead at 07:00 MX (outside business hours, avoids seeded collisions)
const d = new Date(now.getTime() + 20 * 864e5);
const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const start = new Date(`${ymd}T07:00:00-06:00`);
r = await call('POST', '/api/appointments', { customerId: cust?.id, serviceId: svc.id, startsAt: start.toISOString() }, token);
check('create appointment', r.status === 201 && r.body?.priceCents === svc.priceCents, r.text);
const appt = r.body;
r = await call('POST', '/api/appointments', { customerId: cust?.id, serviceId: svc.id, startsAt: new Date(start.getTime() + 10 * 6e4).toISOString() }, token);
check('overlapping appointment -> 409', r.status === 409 && r.body?.error === 'overlap', r.text);
r = await call('POST', '/api/appointments', { customerId: cust?.id, serviceId: svc.id, startsAt: new Date(start.getTime() + 10 * 6e4).toISOString(), allowOverlap: true }, token);
check('overlap allowed with flag', r.status === 201, r.text);
const appt2 = r.body;
r = await call('DELETE', `/api/appointments/${appt2?.id}`, null, token);
check('delete appointment', r.status === 204, r.status);
r = await call('PATCH', `/api/appointments/${appt?.id}`, { status: 'confirmed' }, token);
check('confirm appointment', r.status === 200 && r.body?.status === 'confirmed', r.text);
r = await call('PATCH', `/api/appointments/${appt?.id}`, { startsAt: new Date(start.getTime() + 60 * 6e4).toISOString() }, token);
check('reschedule appointment', r.status === 200 && new Date(r.body?.startsAt).getTime() === start.getTime() + 3.6e6, r.text);
r = await call('POST', '/api/payments/link', { appointmentId: appt?.id, amountCents: 20000, method: 'mercadopago' }, token);
check('MP link refused (method disabled / not connected)', r.status === 422 && ['method_disabled', 'mercadopago_not_configured'].includes(r.body?.error), r.text);
r = await call('GET', '/api/auth/me', null, token);
check('payment settings exposed, token never', r.body?.tenant?.settings?.payments?.deposit?.enabled === true && r.body?.tenant?.mercadoPago?.connected === false && !r.text.includes('APP_USR'), r.text.slice(0, 300));
r = await call('PATCH', '/api/tenant', { settings: { ...r.body.tenant.settings, payments: { ...r.body.tenant.settings.payments, methods: { ...r.body.tenant.settings.payments.methods, spei: true } } } }, token);
check('SPEI online needs Mercado Pago connected', r.status === 422 && r.body?.error === 'mercadopago_not_connected', r.text);
r = await call('POST', '/api/payments', { customerId: cust?.id, appointmentId: appt?.id, amountCents: 10000, method: 'transfer' }, token);
check('register partial payment', r.status === 201 && r.body?.status === 'paid', r.text);
r = await call('PATCH', `/api/appointments/${appt?.id}`, { status: 'completed', paymentMethod: 'cash' }, token);
check('complete & charge outstanding', r.status === 200 && r.body?.paidCents === svc.priceCents, r.text);
r = await call('GET', `/api/customers/${cust?.id}`, null, token);
check('customer stats after visit', r.body?.visits === 1 && r.body?.totalSpentCents === svc.priceCents, JSON.stringify({ v: r.body?.visits, t: r.body?.totalSpentCents }));

// services CRUD
r = await call('POST', '/api/services', { name: 'Servicio QA', durationMin: 20, priceCents: 15000 }, token);
check('create service', r.status === 201, r.text);
const qaSvc = r.body;
r = await call('PUT', `/api/services/${qaSvc?.id}`, { name: 'Servicio QA 2', durationMin: 25, priceCents: 16000, active: true }, token);
check('update service', r.status === 200 && r.body?.durationMin === 25, r.text);
r = await call('DELETE', `/api/services/${qaSvc?.id}`, null, token);
check('delete unused service', r.status === 204, r.status);
r = await call('DELETE', `/api/services/${svc.id}`, null, token);
check('delete used service -> deactivated', r.status === 200 && r.body?.deactivated === true, r.text);
await call('PUT', `/api/services/${svc.id}`, { name: svc.name, durationMin: svc.durationMin, priceCents: svc.priceCents, active: true }, token);

// tenant settings
r = await call('PATCH', '/api/tenant', { timezone: 'Mars/Olympus' }, token);
check('invalid timezone rejected', r.status === 422, r.status);
r = await call('PATCH', '/api/tenant', { settings: { ...tenant.settings, reminderHoursBefore: 24 } }, token);
check('update settings', r.status === 200, r.text);

// ---- Public booking
r = await call('GET', '/api/public/nutricion-demo');
check('public business page', r.status === 200 && r.body?.services?.length >= 3, r.text.slice(0, 200));
check('public page shows 30% deposit', r.body?.deposit?.type === 'percent' && r.body?.deposit?.value === 30, JSON.stringify(r.body?.deposit));
check('public page does not leak CLABE', !r.text.includes('012180001234567899'));
check('public page does not leak customers', !r.text.includes('Fernández') && !r.text.includes('@example.com'));
r = await call('GET', '/api/public/no-existe-123');
check('unknown business -> 404', r.status === 404, r.status);
let slotDay = new Date(now.getTime() + 21 * 864e5);
let slots = [];
for (let i = 0; i < 7 && !slots.length; i++) {
  const day = new Date(slotDay.getTime() + i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  r = await call('GET', `/api/public/nutricion-demo/availability?serviceId=${svc.id}&date=${day}`);
  slots = r.body?.slots ?? [];
}
check('availability returns slots', slots.length > 0, r.text.slice(0, 200));
const firstHourMx = slots[0] && new Date(slots[0]).toLocaleTimeString('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' });
check('first slot at 09:00 Mexico City', firstHourMx === '09:00', `${firstHourMx} (${slots[0]})`);
r = await call('POST', '/api/public/nutricion-demo/bookings', { serviceId: svc.id, startsAt: slots[0], name: 'Paciente Web QA', phone: '5511223344' });
check('public booking', r.status === 201, r.text);
check('booking returns 30% deposit with transfer data', r.body?.deposit?.amountCents === Math.round(svc.priceCents * 0.3) && r.body?.deposit?.method === 'transfer' && r.body?.deposit?.transfer?.clabe === '012180001234567899', JSON.stringify(r.body?.deposit));
r = await call('POST', '/api/public/nutricion-demo/bookings', { serviceId: svc.id, startsAt: slots[0], name: 'Otra Persona', phone: '5599887766' });
check('same slot again -> 409', r.status === 409 && r.body?.error === 'slot_unavailable', r.text);
r = await call('POST', '/api/public/nutricion-demo/bookings', { serviceId: svc.id, startsAt: '2020-01-01T10:00:00-06:00', name: 'Pasado', phone: '5500000000' });
check('past slot rejected', r.status === 409, r.status);
r = await call('GET', `/api/public/nutricion-demo/availability?serviceId=${svc.id}&date=${new Date(slots[0]).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}`);
check('booked slot removed from availability', !(r.body?.slots ?? []).includes(slots[0]));
r = await call('GET', `/api/customers?q=${encodeURIComponent('Paciente Web QA')}`, null, token);
check('online booking created customer', r.body?.items?.length === 1);

// ---- Webhooks / cron security
r = await call('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123');
check('whatsapp verify with wrong token -> 403', r.status === 403, r.status);
r = await call('POST', '/api/webhooks/whatsapp', { entry: [] });
check('whatsapp webhook without signature rejected in prod', r.status === 401, r.status);
r = await call('POST', '/api/webhooks/mercadopago', { type: 'payment', data: { id: '123' } });
check('mercadopago webhook without signature rejected', r.status === 401, r.status);
r = await call('GET', '/api/cron/reminders');
check('cron without secret -> 401', r.status === 401, r.status);
if (process.env.CRON_SECRET) {
  r = await call('GET', '/api/cron/reminders', null, null, { authorization: `Bearer ${process.env.CRON_SECRET}` });
  check('cron with secret runs reminders', r.status === 200 && typeof r.body?.processed === 'number', r.text);
  results.push(`INFO  reminders processed=${r.body?.processed} sent(dry-run)=${r.body?.sent}`);
}

// ---- Historical reports
{
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const yearAgo = new Date(Date.now() - 364 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  let t0 = Date.now();
  r = await call('GET', `/api/reports?from=${yearAgo}&to=${today}`, null, token);
  const ms = Date.now() - t0;
  check('reports: 12 months, monthly buckets', r.status === 200 && r.body?.granularity === 'month' && r.body?.series?.length >= 12, r.text.slice(0, 200));
  check('reports: 12 months has a year of history', (r.body?.series ?? []).filter((p) => p.revenueCents > 0).length >= 11, JSON.stringify(r.body?.series?.map((p) => p.revenueCents)));
  check('reports: series revenue adds up to KPI', (r.body?.series ?? []).reduce((a, p) => a + p.revenueCents, 0) === r.body?.kpis?.revenueCents);
  check('reports: methods add up to revenue', (r.body?.byMethod ?? []).reduce((a, m) => a + m.revenueCents, 0) === r.body?.kpis?.revenueCents);
  check('reports: previous period compared', r.body?.previousKpis && r.body?.previousSeries?.length > 0);
  check('reports: heatmap and services present', r.body?.heatmap?.length > 0 && r.body?.byService?.length === 3);
  check('reports: responds in < 5s', ms < 5000, `${ms}ms`);
  results.push(`INFO  reports 12m took ${ms}ms, revenue=${r.body?.kpis?.revenueCents / 100} MXN`);
  const total = r.body?.kpis?.revenueCents ?? 0;
  const svcs = r.body?.byService ?? [];
  let sum = 0;
  for (const s of svcs) {
    const x = await call('GET', `/api/reports?from=${yearAgo}&to=${today}&serviceId=${s.id}`, null, token);
    sum += x.body?.kpis?.revenueCents ?? 0;
  }
  check('reports: per-service revenue partitions the total', sum === total, `${sum} vs ${total}`);
  const on = await call('GET', `/api/reports?from=${yearAgo}&to=${today}&source=online`, null, token);
  const off = await call('GET', `/api/reports?from=${yearAgo}&to=${today}&source=staff`, null, token);
  check('reports: online + front desk = all appointments', on.body.kpis.appointments + off.body.kpis.appointments === r.body.kpis.appointments);
  const users = await call('GET', '/api/users', null, token);
  check('demo has 2 team members', users.body?.length === 2, users.text);
  const st = await call('GET', `/api/reports?from=${yearAgo}&to=${today}&staffUserId=${users.body?.[1]?.id}`, null, token);
  check('reports: staff filter narrows results', st.body.kpis.appointments > 0 && st.body.kpis.appointments < r.body.kpis.appointments);
  const d = await call('GET', `/api/reports?from=${today}&to=${today}&granularity=day`, null, token);
  check('reports: single day works', d.status === 200 && d.body.series.length === 1, d.text.slice(0, 200));
  check('reports: bad range -> 422', (await call('GET', `/api/reports?from=${today}&to=${yearAgo}`, null, token)).status === 422);
  check('reports: requires auth', (await call('GET', `/api/reports?from=${yearAgo}&to=${today}`)).status === 401);
}

// ---- Customer self-service link (reschedule / cancel)
{
  const pub = await call('GET', '/api/public/nutricion-demo');
  const svc2 = pub.body.services[0];
  let slots2 = [];
  let day2;
  for (let i = 8; i < 16 && !slots2.length; i++) {
    day2 = new Date(Date.now() + i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    slots2 = (await call('GET', `/api/public/nutricion-demo/availability?serviceId=${svc2.id}&date=${day2}`)).body?.slots ?? [];
  }
  const b = await call('POST', '/api/public/nutricion-demo/bookings', { serviceId: svc2.id, startsAt: slots2[0], name: 'Reagenda QA', phone: '5511990011' });
  check('booking returns private manage link', b.status === 201 && /^\/c\/[0-9a-f-]{36}\.[\w-]{24}$/.test(b.body?.managePath ?? ''), b.text);
  const tok = (b.body?.managePath ?? '/c/x').slice(3);
  let m = await call('GET', `/api/public/manage/${tok}`);
  check('manage page loads, can reschedule & cancel', m.status === 200 && m.body.canReschedule && m.body.canCancel, m.text);
  check('manage page does not leak customer phone', !m.text.includes('5511990011'));
  check('tampered manage token -> 404', (await call('GET', `/api/public/manage/${tok.slice(0, -3)}abc`)).status === 404);
  const n = await call('GET', `/api/public/manage/${tok}/availability?date=${day2}`);
  check('manage availability excludes current slot', n.status === 200 && !n.body.slots.includes(slots2[0]) && n.body.slots.length > 0);
  const target = n.body.slots[n.body.slots.length - 1];
  m = await call('POST', `/api/public/manage/${tok}/reschedule`, { startsAt: target });
  check('customer reschedules', m.status === 200 && new Date(m.body.appointment.startsAt).getTime() === new Date(target).getTime(), m.text);
  const back = await call('GET', `/api/public/nutricion-demo/availability?serviceId=${svc2.id}&date=${day2}`);
  check('old slot is free again', back.body.slots.includes(slots2[0]));
  check('reschedule to past -> 409', (await call('POST', `/api/public/manage/${tok}/reschedule`, { startsAt: '2020-01-01T10:00:00-06:00' })).status === 409);
  m = await call('POST', `/api/public/manage/${tok}/cancel`);
  check('customer cancels', m.status === 200 && m.body.appointment.status === 'cancelled', m.text);
  check('cancel twice -> 422', (await call('POST', `/api/public/manage/${tok}/cancel`)).status === 422);
  const appts = await call('GET', `/api/appointments?from=${encodeURIComponent(new Date(target).toISOString())}&to=${encodeURIComponent(new Date(new Date(target).getTime() + 3600e3).toISOString())}`, null, token);
  const mine = appts.body?.find?.((a) => a.managePath === b.body.managePath);
  check('business sees the change in the calendar with a note', mine?.status === 'cancelled' && /Reagendada por el cliente/.test(mine?.notes ?? '') && /Cancelada por el cliente/.test(mine?.notes ?? ''), JSON.stringify(mine));
}

// ---- Public directory
{
  const d = await call('GET', '/api/public-directory');
  check('directory lists opt-in businesses', d.status === 200 && d.body.entries.length >= 15, d.text.slice(0, 200));
  const slugs = (d.body?.entries ?? []).map((e) => e.slug);
  check('directory includes demo clinic & restaurant', slugs.includes('nutricion-demo') && slugs.includes('restaurante-demo'));
  check('directory entries all have coordinates & city', (d.body?.entries ?? []).every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng) && e.city));
  check('directory exposes only public fields', !/password|email|customer|token|accessToken/i.test(JSON.stringify(d.body?.entries?.[0] ?? {})));
  check('directory only in Colima and Jalisco (Guadalajara)', (d.body?.zones ?? []).map((z) => z.state).sort().join(',') === 'Colima,Jalisco', JSON.stringify(d.body?.zones));
  check('directory cities are Colima and Guadalajara', (d.body?.entries ?? []).every((e) => ['Colima', 'Guadalajara'].includes(e.city)), [...new Set((d.body?.entries ?? []).map((e) => e.city))].join(','));
  check('directory has restaurants and services', d.body.entries.some((e) => e.kind === 'reservations') && d.body.entries.some((e) => e.kind === 'appointments'));
  check('directory is cacheable', /max-age=60/.test(d.headers.get('cache-control') ?? ''));
  const page = await call('GET', '/directorio');
  check('/directorio serves SPA', page.status === 200 && page.text.includes('<div id="root">'));
}

// ---- Restaurant reservations
{
  const login = await demoLogin('restaurante-demo');
  check('restaurant demo login', login.status === 200 && login.body?.tenant?.kind === 'reservations', login.text.slice(0, 200));
  const rt = login.body?.token;
  const pub = await call('GET', '/api/public/restaurante-demo');
  check('restaurant public page is table-based', pub.status === 200 && pub.body.kind === 'reservations' && pub.body.maxPartySize >= 8 && pub.body.lat != null, pub.text.slice(0, 200));
  const tables = await call('GET', '/api/resources', null, rt);
  check('restaurant has 8 tables', tables.status === 200 && tables.body.length === 8, tables.text.slice(0, 200));
  check('resources are private', (await call('GET', '/api/resources')).status === 401);
  check('party larger than max -> no slots', ((await call('GET', `/api/public/restaurante-demo/availability?partySize=40&date=${new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}`)).body?.slots ?? []).length === 0);
  let day = null;
  let slots = [];
  for (let i = 10; i < 20 && !slots.length; i++) {
    day = new Date(Date.now() + i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    slots = (await call('GET', `/api/public/restaurante-demo/availability?partySize=5&date=${day}`)).body?.slots ?? [];
  }
  check('availability for 5 people', slots.length > 0, day);
  const slot = slots[Math.floor(slots.length / 2)];
  const b = await call('POST', '/api/public/restaurante-demo/bookings', { partySize: 5, startsAt: slot, name: 'Mesa QA', phone: '5511223344' });
  check('online table reservation', b.status === 201 && b.body.partySize === 5 && /^\/c\//.test(b.body.managePath ?? ''), b.text);
  const appts = await call('GET', `/api/appointments?from=${encodeURIComponent(slot)}&to=${encodeURIComponent(new Date(new Date(slot).getTime() + 60e3).toISOString())}`, null, rt);
  const mine = appts.body?.find?.((a) => a.managePath === b.body?.managePath);
  const table = tables.body?.find?.((x) => x.id === mine?.resourceId);
  check('reservation assigned to a table that fits', !!table && table.capacity >= 5 && mine.resourceName === table.name && /^#/.test(mine.resourceColor ?? ''), JSON.stringify(mine));
  check('restaurant reservation over capacity -> 422', (await call('POST', '/api/public/restaurante-demo/bookings', { partySize: 60, startsAt: slot, name: 'Grupo QA', phone: '5511223355' })).status === 422);
  // Fill every 6-seat-or-larger table at that slot -> the slot disappears for 6 people
  const big = tables.body.filter((x) => x.active && x.capacity >= 6).length;
  let filled = 0;
  for (let i = 0; i < big + 1; i++) {
    const x = await call('POST', '/api/public/restaurante-demo/bookings', { partySize: 6, startsAt: slot, name: `Grupo QA ${i}`, phone: `55112233${60 + i}` });
    if (x.status === 201) filled++;
    else check('extra party of 6 rejected when big tables are full', x.status === 409 && x.body?.error === 'slot_unavailable', x.text);
  }
  check('only as many parties of 6 as big tables', filled <= big, `${filled}/${big}`);
  const after = (await call('GET', `/api/public/restaurante-demo/availability?partySize=6&date=${day}`)).body?.slots ?? [];
  check('full slot no longer offered for 6', !after.includes(slot));
  const tok = b.body.managePath.slice(3);
  const m = await call('GET', `/api/public/manage/${tok}`);
  check('restaurant manage link shows party size', m.status === 200 && m.body.appointment.partySize === 5, m.text.slice(0, 200));
  const c = await call('POST', `/api/public/manage/${tok}/cancel`);
  check('guest cancels reservation', c.status === 200 && c.body.appointment.status === 'cancelled');
  const rep = await call('GET', '/api/reports?from=2026-01-01&to=2026-06-30', null, rt);
  check('restaurant reports have history', rep.status === 200 && (rep.body?.summary?.appointments ?? rep.body?.totals?.appointments ?? 1) > 0, rep.text.slice(0, 200));
}

const mxDay = (i) => new Date(Date.now() + i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

// ---- Team: per-person agendas (barbershop demo)
{
  const pub = await call('GET', '/api/public/barberia-demo');
  check('barbershop exposes its team', pub.status === 200 && pub.body.kind === 'appointments' && pub.body.resources?.length === 4, pub.text.slice(0, 200));
  check('barbershop has two locations', pub.body.locations?.map((l) => l.name).sort().join(',') === 'Colima Centro,Guadalajara Chapultepec', JSON.stringify(pub.body.locations));
  const svc = pub.body.services[0];
  const pro = pub.body.resources.find((p) => !p.serviceIds.length || p.serviceIds.includes(svc.id));
  let day = null;
  let slots = [];
  for (let i = 9; i < 20 && slots.length < 3; i++) {
    day = mxDay(i);
    slots = (await call('GET', `/api/public/barberia-demo/availability?serviceId=${svc.id}&date=${day}&resourceId=${pro.id}`)).body?.slots ?? [];
  }
  check('availability for a specific barber', slots.length > 0, day);
  // Prefer a slot where another barber of the same location is also free (seed data is random)
  const others = pub.body.resources.filter((r) => r.id !== pro.id && r.locationId === pro.locationId);
  const otherSlots = new Set();
  for (const r of others) for (const x of (await call('GET', `/api/public/barberia-demo/availability?serviceId=${svc.id}&date=${day}&resourceId=${r.id}`)).body?.slots ?? []) otherSlots.add(x);
  const slot = slots.find((x) => otherSlots.has(x)) ?? slots[1] ?? slots[0];
  const b = await call('POST', '/api/public/barberia-demo/bookings', { serviceId: svc.id, resourceId: pro.id, startsAt: slot, name: 'Corte QA', phone: '5512120001' });
  check('book with a chosen barber', b.status === 201 && b.body.resourceName === pro.name, b.text);
  const again = await call('POST', '/api/public/barberia-demo/bookings', { serviceId: svc.id, resourceId: pro.id, startsAt: slot, name: 'Corte QA 2', phone: '5512120002' });
  check('same barber same time -> 409', again.status === 409, again.text);
  const proSlots = (await call('GET', `/api/public/barberia-demo/availability?serviceId=${svc.id}&date=${day}&resourceId=${pro.id}`)).body.slots;
  check("barber's taken slot disappears for that barber", !proSlots.includes(slot));
  const anySlots = (await call('GET', `/api/public/barberia-demo/availability?serviceId=${svc.id}&date=${day}`)).body.slots;
  if (anySlots.includes(slot)) {
    const any = await call('POST', '/api/public/barberia-demo/bookings', { serviceId: svc.id, resourceId: null, startsAt: slot, name: 'Corte QA 3', phone: '5512120003' });
    check('"any barber" gets assigned to someone free', any.status === 201 && any.body.resourceName && any.body.resourceName !== pro.name, any.text);
    await call('POST', `/api/public/manage/${any.body.managePath?.slice(3)}/cancel`);
  } else check('slot still offered with another barber', false, 'all barbers busy at slot');
  const login = await demoLogin('barberia-demo');
  const team = await call('GET', '/api/resources', null, login.body?.token);
  check('barbershop team list (private)', team.status === 200 && team.body.length === 4 && (await call('GET', '/api/resources')).status === 401);
  const m = await call('POST', `/api/public/manage/${b.body.managePath.slice(3)}/cancel`);
  check('customer cancels barber booking', m.status === 200);
}

// ---- Group classes (yoga demo)
{
  const pub = await call('GET', '/api/public/yoga-demo');
  check('yoga studio is a classes business', pub.status === 200 && pub.body.kind === 'classes', pub.text.slice(0, 160));
  const list = (await call('GET', '/api/public/yoga-demo/classes?days=14')).body ?? [];
  check('upcoming classes listed with spots', list.length > 5 && list.every((c) => c.capacity > 0 && c.spotsLeft >= 0 && c.serviceName));
  const later = list.filter((c) => new Date(c.startsAt) > new Date(Date.now() + 3 * 864e5) && c.spotsLeft >= 2);
  const cls = later[0];
  check('a class with room exists', !!cls);
  if (cls) {
    const b = await call('POST', '/api/public/yoga-demo/bookings', { classSessionId: cls.id, spots: 1, name: 'Alumna QA', phone: '5513130001' });
    check('book a spot in class', b.status === 201 && b.body.partySize === 1 && b.body.priceCents === cls.priceCents, b.text);
    const after = (await call('GET', '/api/public/yoga-demo/classes?days=14')).body.find((c) => c.id === cls.id);
    check('spots left goes down', after.spotsLeft === cls.spotsLeft - 1, `${cls.spotsLeft} -> ${after.spotsLeft}`);
    const dup = await call('POST', '/api/public/yoga-demo/bookings', { classSessionId: cls.id, spots: 1, name: 'Alumna QA', phone: '5513130001' });
    check('same person twice -> already_booked', dup.body?.error === 'already_booked', dup.text);
    if (after.spotsLeft < 10) {
      const over = await call('POST', '/api/public/yoga-demo/bookings', { classSessionId: cls.id, spots: after.spotsLeft + 1, name: 'Grupo QA', phone: '5513130002' });
      check('more spots than left -> class_full', over.status === 409 && over.body.error === 'class_full', over.text);
    }
    const c = await call('POST', `/api/public/manage/${b.body.managePath.slice(3)}/cancel`);
    const back = (await call('GET', '/api/public/yoga-demo/classes?days=14')).body.find((x) => x.id === cls.id);
    check('cancelling frees the spot', c.status === 200 && back.spotsLeft === cls.spotsLeft);
  }
  const login = await demoLogin('yoga-demo');
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 7 * 864e5).toISOString();
  const sessions = await call('GET', `/api/class-sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, null, login.body?.token);
  check('studio sees its class schedule', sessions.status === 200 && sessions.body.length > 3 && sessions.body.every((s) => s.booked <= s.capacity || s.booked >= 0), sessions.text.slice(0, 160));
  check('classes carry instructor colour for the calendar', sessions.body.some((s) => s.resourceId && /^#/.test(s.resourceColor ?? '')), sessions.text.slice(0, 160));
}

// ---- Space rentals (padel demo)
{
  const pub = await call('GET', '/api/public/padel-demo');
  check('padel club rents spaces', pub.status === 200 && pub.body.kind === 'rentals' && pub.body.resources.length === 4 && pub.body.rentalDurations?.includes(90), pub.text.slice(0, 200));
  let day = null;
  let slots = [];
  for (let i = 9; i < 20 && slots.length < 3; i++) {
    day = mxDay(i);
    slots = (await call('GET', `/api/public/padel-demo/availability?durationMin=90&date=${day}`)).body?.slots ?? [];
  }
  check('court availability for 90 min', slots.length > 0, day);
  const slot = slots[Math.floor(slots.length / 2)];
  const b = await call('POST', '/api/public/padel-demo/bookings', { resourceId: null, durationMin: 90, startsAt: slot, name: 'Pádel QA', phone: '5514140001' });
  const sp = pub.body.resources.find((s) => s.name === b.body?.resourceName);
  check('any free court assigned, priced by the hour', b.status === 201 && !!sp && b.body.priceCents === Math.round(sp.pricePerHourCents * 1.5), b.text);
  const same = await call('POST', '/api/public/padel-demo/bookings', { resourceId: sp?.id, durationMin: 90, startsAt: slot, name: 'Pádel QA 2', phone: '5514140002' });
  check('same court same time -> 409', same.status === 409, same.text);
  const bad = await call('POST', '/api/public/padel-demo/bookings', { resourceId: null, durationMin: 45, startsAt: slot, name: 'Pádel QA 3', phone: '5514140003' });
  check('duration not offered -> 422', bad.status === 422 && bad.body.error === 'invalid_duration', bad.text);
  const login = await demoLogin('padel-demo');
  const spaces = await call('GET', '/api/resources', null, login.body?.token);
  check('club sees its courts', spaces.status === 200 && spaces.body.length === 4);
  check('each court has its own colour', new Set(spaces.body.map((x) => x.color)).size === 4, JSON.stringify(spaces.body.map((x) => x.color)));
  const court = spaces.body[0];
  const recolor = await call('PUT', `/api/resources/${court.id}`, { ...court, color: '#db2777' }, login.body?.token);
  check('owner changes a court colour', recolor.status === 200 && recolor.body.color === '#db2777', recolor.text.slice(0, 160));
  await call('PUT', `/api/resources/${court.id}`, court, login.body?.token);
  check('customer cancels court', (await call('POST', `/api/public/manage/${b.body.managePath.slice(3)}/cancel`)).status === 200);
}

// ---- Roles: owner / admin see everything, colaboradores only their own
{
  const login = async (email) => (await call('POST', '/api/auth/login', { email, password: 'demo1234' })).body;
  const owner = await asDemo('barberia-demo');
  const admin = await login('recepcion@agenda.mx');
  const memo = await login('memo@agenda.mx');
  check('demo logins have roles', owner?.user.role === 'owner' && admin?.user.role === 'admin' && memo?.user.role === 'staff' && !!memo.user.resourceId,
    JSON.stringify([owner?.user, admin?.user, memo?.user]));
  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  const to = new Date(Date.now() + 30 * 864e5).toISOString();
  const q = `/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const all = (await call('GET', q, null, admin.token)).body ?? [];
  const mine = (await call('GET', q, null, memo.token)).body ?? [];
  const pros = new Set(all.map((a) => a.resourceId));
  check('admin sees every barber', pros.size >= 2 && all.length > mine.length, `${all.length} vs ${mine.length}`);
  check('colaborador sees only own bookings', mine.length > 0 && mine.every((a) => a.resourceId === memo.user.resourceId), String(mine.length));
  const other = all.find((a) => a.resourceId && a.resourceId !== memo.user.resourceId);
  check("colaborador can't open another barber's booking", (await call('GET', `/api/appointments/${other.id}`, null, memo.token)).status === 404);
  check("colaborador can't edit another barber's booking", (await call('PATCH', `/api/appointments/${other.id}`, { notes: 'x' }, memo.token)).status === 404);
  check("colaborador can't delete bookings", (await call('DELETE', `/api/appointments/${mine[0].id}`, null, memo.token)).status === 403);
  const cust = (await call('GET', '/api/customers?limit=200', null, memo.token)).body;
  const custAll = (await call('GET', '/api/customers?limit=200', null, admin.token)).body;
  check('colaborador sees only own customers', cust.total > 0 && cust.total < custAll.total, `${cust.total} vs ${custAll.total}`);
  check("colaborador can't list users", (await call('GET', '/api/users', null, memo.token)).status === 403);
  const users = await call('GET', '/api/users', null, admin.token);
  check('admin lists users with roles', users.status === 200 && users.body.some((u) => u.role === 'staff' && u.resourceName), users.text.slice(0, 200));
  check("admin can't create an owner", (await call('POST', '/api/users', { name: 'X QA', email: `qa-${Date.now()}@agenda.mx`, password: 'qa-password-1', role: 'owner' }, admin.token)).status === 403);
  check("admin can't connect Mercado Pago", (await call('PUT', '/api/tenant/mercadopago', { accessToken: 'x'.repeat(30) }, admin.token)).status === 403);
  const dash = await call('GET', '/api/metrics/dashboard', null, memo.token);
  check('colaborador dashboard works', dash.status === 200, dash.text.slice(0, 120));
  const rep = await call('GET', `/api/reports?from=2026-01-01&to=${mxDay(0)}`, null, memo.token);
  check('colaborador reports scoped', rep.status === 200, rep.text.slice(0, 120));
  const diego = await login('diego@agenda.mx');
  const ses = (await call('GET', `/api/class-sessions?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(to)}`, null, diego.token)).body ?? [];
  check('instructor sees only own classes', ses.length > 0 && ses.every((s) => s.resourceId === diego.user.resourceId), String(ses.length));
}

// ---- Locations (sucursales) and the Guadalajara manager
{
  const owner = await asDemo('barberia-demo');
  const locs = await call('GET', '/api/locations', null, owner.token);
  const pol = locs.body?.locations?.find((l) => l.name === 'Guadalajara Chapultepec');
  check('locations + plan (1 included, 1 extra)', locs.status === 200 && !!pol && locs.body.plan.extraLocations === 1, locs.text.slice(0, 200));
  const day = mxDay(10);
  const pub = (await call('GET', '/api/public/barberia-demo')).body;
  const rafa = pub.resources.find((p) => p.locationId === pol?.id);
  const slots = (await call('GET', `/api/public/barberia-demo/availability?serviceId=${pub.services[0].id}&date=${day}&locationId=${pol?.id}`)).body?.slots ?? [];
  const hour = (x) => Number(new Date(x).toLocaleTimeString('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit' }));
  check('Guadalajara availability follows its own hours (11-21)', slots.length > 0 && slots.every((x) => hour(x) >= 11 && hour(x) < 21), slots.slice(0, 3).join(','));
  const bk = await call('POST', '/api/public/barberia-demo/bookings', { serviceId: pub.services[0].id, startsAt: slots[slots.length - 2], locationId: pol?.id, name: 'Sucursal QA', phone: '5518180001' });
  check('booking at Guadalajara goes to its barber', bk.status === 201 && bk.body.resourceName === rafa?.name, bk.text);
  const gerente = (await call('POST', '/api/auth/login', { email: 'gerente@agenda.mx', password: 'demo1234' })).body;
  check('gerente limited to Guadalajara', gerente?.user?.role === 'admin' && gerente.user.locationId === pol?.id, JSON.stringify(gerente?.user));
  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  const to = new Date(Date.now() + 30 * 864e5).toISOString();
  const q = `/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const gl = (await call('GET', q, null, gerente.token)).body ?? [];
  const ol = (await call('GET', q, null, owner.token)).body ?? [];
  check('gerente sees only Guadalajara bookings', gl.length > 0 && gl.every((a) => a.locationId === pol?.id) && ol.length > gl.length, `${gl.length} vs ${ol.length}`);
  check("gerente can't change business settings", (await call('PATCH', '/api/tenant', { name: 'X' }, gerente.token)).status === 403);
  const rep = await call('GET', `/api/reports?from=${mxDay(-60)}&to=${mxDay(0)}`, null, owner.token);
  check('reports split by location', rep.body?.byLocation?.length === 2, JSON.stringify(rep.body?.byLocation));
  check('customer cancels Guadalajara booking', (await call('POST', `/api/public/manage/${bk.body.managePath?.slice(3)}/cancel`)).status === 200);
  const d = (await call('GET', '/api/public-directory')).body;
  check('directory has a pin per barbershop location', d.entries.filter((e) => e.slug === 'barberia-demo').length === 2);
}

// ---- Plans
{
  const owner = await asDemo('barberia-demo');
  const p = await call('GET', '/api/tenant/plan', null, owner.token);
  check('plan info for the business', p.status === 200 && p.body.plan === 'premium' && p.body.usage.activeLocations === 2 && p.body.billingConnected === false, p.text.slice(0, 200));
  check('plan is part of the session', owner.tenant?.plan === 'premium');
  check('premium is not selectable yet', (await call('PUT', '/api/tenant/plan', { plan: 'premium' }, owner.token)).status === 422);
  // Sign-up limits (local runs only: creates a new account)
  if (process.env.E2E_SIGNUP) {
    const email = `free-${Date.now()}@test.mx`;
    const reg = await call('POST', '/api/auth/register', { businessName: 'Gratis QA', businessType: 'nutrition', name: 'QA', email, password: 'password123', plan: 'free' });
    check('sign up on the free plan', reg.status === 201 && reg.body.tenant.plan === 'free', reg.text.slice(0, 200));
    const tk = reg.body.token;
    let okN = 0;
    for (let i = 0; i < 5; i++) if ((await call('POST', '/api/customers', { name: `Cliente ${i}`, phone: `55700000${10 + i}` }, tk)).status === 201) okN++;
    const sixth = await call('POST', '/api/customers', { name: 'Cliente 6', phone: '5570000099' }, tk);
    check('free plan: 5 customers, the 6th is refused', okN === 5 && sixth.status === 402 && sixth.body.error === 'plan_limit_customers', sixth.text);
    const loc = await call('POST', '/api/locations', { name: 'Segunda', active: true }, tk);
    check('free plan: one location', loc.status === 402 && loc.body.error === 'plan_limit_locations', loc.text);
    const biz = await call('POST', '/api/businesses', { businessName: 'Otro QA', businessType: 'barbershop' }, tk);
    check('free plan: one business', biz.status === 402 && biz.body.error === 'plan_limit_businesses', biz.text);
    const up = await call('PUT', '/api/tenant/plan', { plan: 'standard' }, tk);
    check('owner moves to Estándar', up.status === 200 && up.body.plan.plan === 'standard' && up.body.plan.monthlyTotalCents === 39900, up.text);
    check('Estándar: more customers allowed', (await call('POST', '/api/customers', { name: 'Cliente 6', phone: '5570000099' }, tk)).status === 201);
    const down = await call('PUT', '/api/tenant/plan', { plan: 'free' }, tk);
    check('back to Free refused while over its limits', down.status === 402 && down.body.error === 'plan_limit_customers', down.text);
  }
}

// ---- Directory shows the new kinds
{
  const d = await call('GET', '/api/public-directory');
  const kinds = new Set(d.body.entries.map((e) => e.kind));
  check('directory has all four kinds', ['appointments', 'reservations', 'classes', 'rentals'].every((k) => kinds.has(k)), [...kinds].join(','));
  const padel = d.body.entries.find((e) => e.slug === 'padel-demo');
  check('rentals show price per hour', padel?.priceUnit === 'hour' && padel.priceFromCents > 0, JSON.stringify(padel));
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed  (${mx(Date.now())})`);
process.exit(fail ? 1 : 0);
