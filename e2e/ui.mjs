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
await page.fill('input[type=datetime-local]', '2026-12-01T07:00');
await page.locator('form .btn-primary').last().click();
await page.waitForTimeout(1500);
const dec = await api(`/appointments?from=${encodeURIComponent('2026-12-01T00:00:00-06:00')}&to=${encodeURIComponent('2026-12-02T00:00:00-06:00')}`, null, tok);
ok('booking created for picked customer', dec.some((a) => a.customerName === pickedName), pickedName + ' ' + dec.map((a) => a.customerName).slice(0, 3));
// 2. A past booking that wasn't paid shows "Debe" without anyone marking it
const svcs = await api('/services', null, tok);
const cust0 = (await api('/customers?limit=1', null, tok)).items[0];
const y = new Date(Date.now() - 864e5); y.setHours(7, 0, 0, 0);
const past = await api('/appointments', { customerId: cust0.id, serviceId: svcs.find((x) => x.active && x.priceCents > 0).id, startsAt: y.toISOString(), allowOverlap: true }, tok);
ok('past booking created', !!past.id, JSON.stringify(past).slice(0, 120));
await page.addInitScript(() => localStorage.setItem('agenda.view', 'week'));
await page.goto('http://localhost:5173/agenda');
await page.waitForSelector('[data-testid=calendar-event]');
if (y.getDay() === 1) await page.getByRole('button', { name: /Anterior|anterior|prev/i }).first().click();
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
await page.goto('http://localhost:5173/settings');
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
await page.goto('http://localhost:5173/payments');
await page.waitForSelector('tbody tr');
const rowsAll = await page.locator('tbody tr').count();
await page.getByRole('button', { name: /Filtros/ }).click();
await page.selectOption('#pf-method', 'cash');
await page.waitForTimeout(300);
const rowsCash = await page.locator('tbody tr').count();
ok('payments filter still works', rowsCash > 0 && rowsCash < rowsAll, `${rowsAll}->${rowsCash}`);
ok('active filter count shown', (await page.getByRole('button', { name: /Filtros\s*1/ }).count()) === 1);
ok('no page errors', errors.length === 0, errors.join(' / '));
await browser.close();
console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
