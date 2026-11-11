/**
 * Browser checks of the main flows with the demo data (login lands on the agenda, picking a
 * customer, payment states, report layout drag and drop, compact filters).
 * Needs the API on :3000 and the web on :5173 with a freshly seeded database, and Playwright:
 *   npm i -D playwright && npx playwright install chromium && node e2e/ui.mjs
 */
import { chromium } from 'playwright';
const API = 'http://localhost:3000/api';
const api = async (p, body, tok, method) => (await fetch(API + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const out = [];
const ok = (name, cond, info = '') => out.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : info}`);
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'es-MX' });
page.on('pageerror', (e) => { if (!/_leaflet_pos/.test(e.message)) errors.push(e.message); });
await page.goto('http://localhost:5173/?login=1');
await page.fill('#email', 'demo@agenda.mx');
await page.fill('#password', 'demo1234');
await page.locator('form .btn-primary').first().click();
await page.waitForURL(/\/agenda/);
const tok = await page.evaluate(() => localStorage.getItem('agenda.token'));
ok('Inicio gone from menu', (await page.locator('nav a[href="/inicio"]').count()) === 0);
// 1. New booking: search and pick a customer, then save
await page.getByRole('button', { name: /Nueva cita|Nueva reserva/ }).first().click();
const search = page.getByRole('searchbox', { name: /Cliente/ });
// Typing part of a name filters the list; take the first match of whatever business opened
await page.locator('[role=listbox] button').first().waitFor();
const firstName = ((await page.locator('[role=listbox] button .font-medium').first().textContent()) ?? '').split(' ')[0];
await search.fill(firstName);
await page.waitForTimeout(600);
await page.locator('[role=listbox] button').first().click();
ok('customer picked shows card', (await page.locator('[data-testid=picked-customer]').count()) === 1);
const pickedName = await page.locator('[data-testid=picked-customer] .truncate').first().textContent();
if (await page.locator('#na-svc').count()) await page.selectOption('#na-svc', { index: 1 });
await page.fill('#na-day', '2026-12-01');
await page.fill('#na-time', '07:00');
await page.waitForTimeout(800);
await page.locator('form .btn-primary').last().click();
await page.waitForTimeout(1500);
const dec = await api(`/appointments?from=${encodeURIComponent('2026-12-01T00:00:00-06:00')}&to=${encodeURIComponent('2026-12-02T00:00:00-06:00')}`, null, tok);
ok('booking created for picked customer', dec.some((a) => a.customerName === pickedName), pickedName + ' ' + dec.map((a) => a.customerName).slice(0, 3));
// 1b. Typing a name that isn't on the list registers a new customer right there,
//     and a taken time shows up before saving, with free options to tap
await page.getByRole('button', { name: /Nueva cita|Nueva reserva/ }).first().click();
const newName = `Zacarías Nuevo ${Date.now() % 10000}`;
await page.getByRole('searchbox', { name: /Cliente/ }).fill(newName);
await page.getByTestId('new-customer').waitFor({ timeout: 5000 }).catch(() => {});
ok('unknown name becomes a new customer', ((await page.getByTestId('new-customer').textContent().catch(() => '')) ?? '').includes('no está en tu lista'));
await page.getByTestId('new-customer').locator('input[type=tel]').fill('3121112233');
if (await page.locator('#na-svc').count()) await page.selectOption('#na-svc', { index: 1 });
const resIds = await page.locator('#na-res option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
let warned = false;
if (resIds.length) {
  const svcId = await page.locator('#na-svc').inputValue().catch(() => undefined);
  const busyCust = (await api('/customers?limit=1', null, tok)).items[0];
  // 10:00 in the browser's own time zone, the same way the form reads it
  const at10 = await page.evaluate(() => new Date('2026-12-02T10:00').toISOString());
  const blocker = await api('/appointments', { customerId: busyCust.id, ...(svcId ? { serviceId: svcId } : {}), resourceId: resIds[0], startsAt: at10, allowOverlap: true }, tok);
  await page.selectOption('#na-res', resIds[0]);
  await page.fill('#na-day', '2026-12-02');
  await page.fill('#na-time', '10:00');
  await page.getByTestId('slot-taken').waitFor({ timeout: 6000 }).catch(() => {});
  warned = await page.getByTestId('slot-taken').isVisible().catch(() => false);
  ok('taken time warned before saving', warned);
  ok('save disabled while taken', await page.locator('form .btn-primary').last().isDisabled());
  const chips = page.getByTestId('slot-taken').locator('button');
  ok('suggestions offered', (await chips.count()) > 0);
  await chips.first().click();
  await page.getByTestId('slot-free').waitFor({ timeout: 6000 }).catch(() => {});
  ok('suggestion makes it free', await page.getByTestId('slot-free').isVisible().catch(() => false));
  await page.locator('form .btn-primary').last().click();
  await page.waitForTimeout(1500);
  const found = (await api(`/customers?q=${encodeURIComponent(newName)}`, null, tok)).items[0];
  ok('new customer saved with phone', !!found && (found.phone ?? '').includes('3121112233'), JSON.stringify(found ?? null).slice(0, 120));
  await api(`/appointments/${blocker.id}`, null, tok, 'DELETE').catch(() => null);
} else {
  await page.keyboard.press('Escape');
}
// 2. A past booking that wasn't paid shows "Debe" without anyone marking it
const svcs = await api('/services', null, tok);
const cust0 = (await api('/customers?limit=1', null, tok)).items[0];
const y = new Date(Date.now() - 864e5); y.setHours(7, 0, 0, 0);
const past = await api('/appointments', { customerId: cust0.id, serviceId: svcs.find((x) => x.active && x.priceCents > 0).id, startsAt: y.toISOString(), allowOverlap: true }, tok);
ok('past booking created', !!past.id, JSON.stringify(past).slice(0, 120));
await page.addInitScript(() => localStorage.setItem('agenda.view', 'week'));
await page.goto('http://localhost:5173/agenda');
await page.waitForSelector('[data-testid=calendar-event]');
await page.waitForTimeout(500);
const label = await page.evaluate((name) => {
  const evs = [...document.querySelectorAll('[data-testid=calendar-event]')];
  return evs.map((e) => e.getAttribute('aria-label') ?? '').find((l) => l.startsWith('07:00') && l.includes(name)) ?? null;
}, cust0.name);
ok('past unpaid booking says Debe', !!label && label.includes('Debe'), String(label));
// 3. No-show not charged setting
const me = await api('/auth/me', null, tok);
await api('/tenant', { settings: { ...me.tenant.settings, payments: { ...me.tenant.settings.payments, noShowOwes: false } } }, tok, 'PATCH');
const me2 = await api('/auth/me', null, tok);
ok('no-show setting saved', me2.tenant.settings.payments.noShowOwes === false);
await page.goto('http://localhost:5173/settings?tab=payments');
await page.waitForTimeout(800);
ok('no-show option in settings', (await page.getByText('No se le cobra').count()) > 0);
await api('/tenant', { settings: { ...me.tenant.settings } }, tok, 'PATCH');
// 4. Reports: widgets render, drag with keyboard reorders and persists
await page.goto('http://localhost:5173/reports');
await page.waitForSelector('[aria-label^="Mover"]');
const titles = async () => page.locator('section.card h2').allTextContents();
const before = await titles();
ok('reports has upcoming block', before.some((x) => /Próximas citas/.test(x)), before.join('|'));
const handle = page.locator('[aria-label^="Mover"]').nth(1);
await handle.focus();
await page.keyboard.press('Space');
await page.waitForTimeout(200);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const afterDrag = await titles();
ok('drag reorders blocks', afterDrag.join('|') !== before.join('|'), afterDrag.slice(0, 4).join('|'));
await page.reload();
await page.waitForSelector('[aria-label^="Mover"]');
ok('order persists after reload', (await titles()).join('|') === afterDrag.join('|'));
// mouse drag too (moving gradually, like a person)
const t1 = await titles();
const hb = await page.locator('[aria-label^="Mover"]').nth(1).boundingBox();
const tb = await page.locator('[aria-label^="Mover"]').nth(3).boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(hb.x + ((tb.x - hb.x) * i) / 20 + 5, hb.y + ((tb.y - hb.y) * i) / 20 + 5);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(500);
ok('mouse drag reorders', (await titles()).join('|') !== t1.join('|'));
// 5. Compact filters
const filterBtn = page.getByRole('button', { name: /^Filtros/ });
ok('filters collapsed by default', (await page.locator('select[aria-label="Servicio"]').count()) === 0);
await filterBtn.click();
ok('filters open on click', (await page.locator('select[aria-label="Servicio"]').count()) === 1);
// Long lists come in pages: count with the pager ("1–50 de 312") when there is one
const listTotal = async () => {
  const txt = await page.locator('nav[aria-label="Páginas"] span').first().textContent({ timeout: 1000 }).catch(() => null);
  return txt ? Number(txt.match(/de (\d+)/)[1]) : page.locator('tbody tr').count();
};
// Cobros: one row per booking with its state; tiles filter the list
await page.goto('http://localhost:5173/payments');
await page.waitForSelector('tbody tr');
ok('Cobros in the menu', (await page.locator('nav a[href="/payments"]').first().textContent())?.includes('Cobros'));
const allBookings = await listTotal();
ok('cobros list is paginated', (await page.locator('tbody tr').count()) <= 50);
await page.getByRole('button', { name: /Debe\b/ }).first().click();
await page.waitForTimeout(300);
const owedRows = await listTotal();
const owedShown = await page.locator('tbody tr').count();
const owedBadges = await page.locator('tbody tr td:nth-child(3), tbody tr td:nth-child(4)').filter({ hasText: /Debe/ }).count();
ok('owed tile filters bookings', owedRows > 0 && owedRows < allBookings && owedBadges >= owedShown, `${allBookings}->${owedRows} (${owedBadges})`);
const recordBtn = page.getByRole('button', { name: 'Registrar pago' }).first();
await recordBtn.click();
ok('record payment only offers in-person methods', !(await page.locator('#rp-method option').allTextContents()).some((m) => /Mercado Pago/.test(m)));
await page.keyboard.press('Escape');
// Movements tab keeps the payment records
await page.goto('http://localhost:5173/payments?tab=movements');
await page.waitForSelector('tbody tr');
const rowsAll = await listTotal();
await page.getByRole('button', { name: /Filtros/ }).click();
await page.selectOption('#pf-method', 'cash');
await page.waitForTimeout(300);
const rowsCash = await listTotal();
ok('payments filter still works', rowsCash > 0 && rowsCash < rowsAll, `${rowsAll}->${rowsCash}`);
ok('active filter count shown', (await page.getByRole('button', { name: /Filtros\s*1/ }).count()) === 1);
// Customers come 50 at a time
await page.goto('http://localhost:5173/customers');
await page.waitForSelector('tbody tr');
const custTotal = await listTotal();
ok('customers paginated', (await page.locator('tbody tr').count()) === Math.min(50, custTotal) && custTotal > 50, String(custTotal));
await page.getByRole('button', { name: 'Página siguiente' }).click();
await page.waitForTimeout(600);
ok('customers next page', /^51–/.test((await page.locator('nav[aria-label="Páginas"] span').first().textContent()) ?? ''));
// Settings in tabs
await page.goto('http://localhost:5173/settings');
await page.waitForSelector('[role=tab]');
const tabNames = await page.locator('[role=tab]').allTextContents();
ok('settings tabs', ['Negocio', 'Reservas', 'Pagos', 'Usuarios', 'Mi cuenta'].every((x) => tabNames.includes(x)), tabNames.join('|'));
await page.getByRole('tab', { name: 'Usuarios' }).click();
ok('users tab shows logins', await page.getByText('Usuarios con acceso').isVisible());
ok('payments not on users tab', (await page.getByText('Métodos de pago').count()) === 0);
// Booking window: status from its chip, payment methods under the pill, edit in place
// Tomorrow before opening, so it isn't folded into a busy hour's "+N más"
const tmw = new Date(Date.now() + 864e5); tmw.setHours(7, 30, 0, 0);
const bk = await api('/appointments', { customerId: cust0.id, serviceId: svcs.find((x) => x.active && x.priceCents > 0).id, startsAt: tmw.toISOString(), allowOverlap: true }, tok);
await api('/payments', { customerId: cust0.id, appointmentId: bk.id, amountCents: 5000, method: 'cash' }, tok);
await page.addInitScript(() => localStorage.setItem('agenda.view', 'week'));
await page.goto('http://localhost:5173/agenda');
await page.waitForSelector('[data-testid=calendar-event]');
const target = (await page.locator('[data-testid=calendar-event]').all()).length;
let opened = false;
for (let week = 0; week < 2 && !opened; week++) {
  if (week) {
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await page.waitForTimeout(800);
  }
  for (const e of await page.locator(`[data-testid=calendar-event][aria-label*="${cust0.name}"]`).all()) {
    await e.click();
    await page.waitForTimeout(400);
    if (await page.getByTestId('status-menu').count()) {
      if (((await page.getByTestId('paid-methods').textContent().catch(() => '')) ?? '').includes('Efectivo') && (await page.getByTestId('edit-time').count())) { opened = true; break; }
      await page.keyboard.press('Escape');
    }
  }
}
ok('booking shows payment method under the pill', opened, String(target));
ok('no status dropdown below', (await page.locator('#am-status').count()) === 0);
await page.getByTestId('status-menu').click();
await page.getByRole('menuitemradio', { name: /Confirmada/ }).click();
await page.waitForTimeout(800);
ok('status changed from the chip', (await api(`/appointments/${bk.id}`, null, tok)).status === 'confirmed');
await page.getByTestId('edit-time').click();
ok('time edits in place', (await page.locator('[role=dialog] input[type=datetime-local]').count()) === 1);
const dlg = page.locator('[role=dialog]');
await dlg.getByRole('button', { name: 'Cancelar', exact: true }).click();
await dlg.getByRole('button', { name: 'Cobrar', exact: true }).click();
await page.selectOption('#am-method', 'card');
await dlg.getByRole('button', { name: 'Registrar pago', exact: true }).click();
await page.waitForTimeout(1000);
const after = await api(`/appointments/${bk.id}`, null, tok);
ok('charge in place settles it', after.paidCents >= after.priceCents && after.paidMethods.includes('card'), JSON.stringify(after.paidMethods));
ok('window shows both methods', ((await page.getByTestId('paid-methods').textContent()) ?? '').includes('Tarjeta'));
await page.keyboard.press('Escape');
await api(`/appointments/${bk.id}`, null, tok, 'DELETE').catch(() => null);
// Public page looks like a profile
await page.goto('http://localhost:5173/b/barberia-demo');
await page.getByTestId('profile-header').waitFor();
const head = (await page.getByTestId('profile-header').textContent()) ?? '';
ok('public page header has hours, notice and socials', head.includes('🕒') && head.includes('2x1') && head.includes('Instagram'), head.slice(0, 160));
// Payments settings: no-show sits next to deposit (no long scroll)
await page.goto('http://localhost:5173/settings?tab=payments');
await page.getByText('Cuando un cliente no asiste').waitFor();
const noShowBox = await page.getByText('Cuando un cliente no asiste').boundingBox();
const methodsBox = await page.getByText('Métodos de pago').boundingBox();
ok('no-show in right column', !!noShowBox && !!methodsBox && noShowBox.x > methodsBox.x + 200, JSON.stringify([noShowBox?.x, methodsBox?.x]));
// Promotions: settings tab, coupon in a new booking
await page.goto('http://localhost:5173/settings?tab=promos');
await page.getByTestId('coupons-section').filter({ hasText: 'BIENVENIDA' }).waitFor({ timeout: 8000 }).catch(() => {});
ok('promotions tab shows rewards and coupons', (await page.getByTestId('rewards-section').isVisible()) && ((await page.getByTestId('coupons-section').textContent()) ?? '').includes('BIENVENIDA'));
await page.goto('http://localhost:5173/agenda');
await page.getByRole('button', { name: /Nueva cita|Nueva reserva/ }).first().click();
await page.locator('[role=listbox] button').first().click();
if (await page.locator('#na-svc').count()) await page.selectOption('#na-svc', { index: 1 });
await page.fill('#na-coupon', 'bienvenida');
await page.getByTestId('discount-preview').filter({ hasText: 'BIENVENIDA' }).waitFor({ timeout: 8000 }).catch(() => {});
ok('coupon discount previewed', ((await page.getByTestId('discount-preview').textContent().catch(() => '')) ?? '').includes('BIENVENIDA'));
await page.keyboard.press('Escape');
// ---- Packages, records, commissions, cash, reviews and calendar
await page.goto('http://localhost:5173/settings?tab=packages');
await page.getByTestId('offerings-section').filter({ hasText: '5 cortes' }).waitFor({ timeout: 8000 }).catch(() => {});
ok('packages tab shows the catalog', ((await page.getByTestId('offerings-section').textContent()) ?? '').includes('5 cortes'));
ok('gift cards listed', ((await page.getByTestId('gift-cards-section').textContent()) ?? '').includes('REGALO24'));
await page.goto('http://localhost:5173/settings?tab=reviews');
await page.getByTestId('reviews-section').filter({ hasText: '★' }).waitFor({ timeout: 8000 }).catch(() => {});
ok('reviews tab shows reviews with replies', ((await page.getByTestId('reviews-section').textContent()) ?? '').includes('Respuesta del negocio'));
await page.goto('http://localhost:5173/settings?tab=account');
await page.getByTestId('calendar-links').waitFor({ timeout: 8000 }).catch(() => {});
const icsUrl = await page.getByTestId('calendar-links').locator('input').first().inputValue().catch(() => '');
const ics = icsUrl ? await (await fetch(icsUrl.replace(/^https?:\/\/[^/]+/, 'http://localhost:3000'))).text() : '';
ok('calendar link serves iCal', ics.startsWith('BEGIN:VCALENDAR') && !/\+52\d{8}/.test(ics), icsUrl);
await page.goto('http://localhost:5173/payments?tab=commissions');
await page.getByTestId('commissions-tab').locator('tbody tr').first().waitFor({ timeout: 8000 }).catch(() => {});
ok('commissions report has rows', (await page.getByTestId('commissions-tab').locator('tbody tr').count()) > 0);
await page.goto('http://localhost:5173/payments?tab=cash');
await page.getByTestId('cash-history').locator('li').first().waitFor({ timeout: 8000 }).catch(() => {});
ok('cash closing history shown', ((await page.getByTestId('cash-history').textContent()) ?? '').includes('Faltaron'));
await page.fill('#cash-counted', '1');
ok('cash difference computed', ((await page.getByTestId('cash-diff').textContent().catch(() => '')) ?? '').includes('$'));
// Customer with a package: sessions left; record section with a note
const withPlan = (await api('/customers?limit=200', null, tok)).items;
let planCustomer = null;
for (const c of withPlan) {
  const pl = await api(`/customers/${c.id}/plans`, null, tok);
  if (pl.plans?.some((p) => p.status === 'active')) { planCustomer = c; break; }
}
if (planCustomer) {
  await page.goto(`http://localhost:5173/customers/${planCustomer.id}`);
  await page.getByTestId('customer-plans').waitFor({ timeout: 8000 }).catch(() => {});
  ok('customer shows sessions left', ((await page.getByTestId('sessions-left').first().textContent().catch(() => '')) ?? '').match(/Queda|Ilimitadas/) != null);
  await page.getByTestId('record-section').waitFor({ timeout: 8000 }).catch(() => {});
  await page.getByTestId('record-section').getByRole('textbox', { name: 'Notas clínicas o de servicio' }).fill('Nota de prueba UI');
  await page.getByTestId('record-section').getByRole('button', { name: 'Agregar' }).click();
  await page.getByTestId('record-notes').filter({ hasText: 'Nota de prueba UI' }).waitFor({ timeout: 6000 }).catch(() => {});
  ok('record note added with author', ((await page.getByTestId('record-notes').textContent()) ?? '').includes('Nota de prueba UI'));
} else ok('a customer with a package exists', false);
// Public: rating and reviews on the booking page and the directory; leave a review
await page.goto('http://localhost:5173/b/barberia-demo');
await page.getByTestId('public-reviews').waitFor({ timeout: 8000 }).catch(() => {});
ok('booking page shows rating and reviews', (await page.getByTestId('rating-badge').count()) > 0 && (await page.getByTestId('public-reviews').count()) > 0);
await page.goto('http://localhost:5173/');
await page.getByTestId('rating-badge').first().waitFor({ timeout: 8000 }).catch(() => {});
ok('directory cards show rating', (await page.getByTestId('rating-badge').count()) > 0);
const pastDone = (await api(`/appointments?from=${encodeURIComponent(new Date(Date.now() - 20 * 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}`, null, tok)).filter((a) => a.status === 'completed');
const listed = new Set((await api('/reviews', null, tok)).items.map((r) => r.appointmentId));
const toReview = pastDone.find((a) => !listed.has(a.id));
if (toReview) {
  await page.goto(`http://localhost:5173${toReview.managePath}`);
  await page.getByTestId('review-link').click();
  await page.getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: 'Enviar reseña' }).click();
  await page.getByTestId('review-done').waitFor({ timeout: 6000 }).catch(() => {});
  ok('customer leaves a verified review', await page.getByTestId('review-done').isVisible().catch(() => false));
} else ok('a completed booking to review exists', false);
ok('no page errors', errors.length === 0, errors.join(' / '));
await browser.close();
console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
