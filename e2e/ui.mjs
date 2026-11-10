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
page.on('pageerror', (e) => errors.push(e.message));
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
const pickedName = await page.locator('[data-testid=picked-customer] .font-medium').textContent();
await page.fill('input[type=datetime-local]', '2026-12-01T07:00');
await page.locator('form .btn-primary').last().click();
await page.waitForTimeout(1500);
const dec = await api(`/appointments?from=${encodeURIComponent('2026-12-01T00:00:00-06:00')}&to=${encodeURIComponent('2026-12-02T00:00:00-06:00')}`, null, tok);
ok('booking created for picked customer', dec.some((a) => a.customerName === pickedName), pickedName + ' ' + dec.map((a) => a.customerName).slice(0, 3));
// 2. Past unpaid booking shows "Debe"
const past = (await api(`/appointments?from=${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`, null, tok)).find((a) => (a.status === 'scheduled' || a.status === 'confirmed') && a.paidCents < a.priceCents);
ok('there is a past unpaid booking to check', !!past);
if (past) {
  await page.addInitScript(() => localStorage.setItem('agenda.view', 'week'));
  await page.goto('http://localhost:5173/agenda');
  await page.waitForSelector('[data-testid=calendar-event]');
  const card = page.locator(`[data-testid=calendar-event][aria-label*="${past.customerName}"]`).first();
  if (await card.count()) {
    const label = await card.getAttribute('aria-label');
    ok('past unpaid card says Debe', label.includes('Debe'), label);
  } else ok('past unpaid card visible this week', false, past.startsAt);
}
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
// mouse drag too
const h0 = page.locator('[aria-label^="Mover"]').nth(2);
const b0 = await h0.boundingBox();
const target = await page.locator('[aria-label^="Mover"]').nth(4).boundingBox();
const t1 = await titles();
await page.mouse.move(b0.x + 5, b0.y + 5); await page.mouse.down();
await page.mouse.move(b0.x + 20, b0.y + 30, { steps: 5 });
await page.mouse.move(target.x + 5, target.y + 40, { steps: 15 }); await page.mouse.up();
await page.waitForTimeout(500);
ok('mouse drag reorders', (await titles()).join('|') !== t1.join('|'));
// 5. Compact filters
const filterBtn = page.getByRole('button', { name: /^⚲\s*Filtros/ });
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
