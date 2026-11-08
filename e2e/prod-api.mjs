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
check('customers list (20 seeded)', r.status === 200 && r.body?.total === 20, r.body?.total);
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

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed  (${mx(Date.now())})`);
process.exit(fail ? 1 : 0);
