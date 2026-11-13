/**
 * Point of sale: several open tickets at once, and selling without internet on a register.
 * Needs the API on :3000 and the web on BASE (vite dev :5173, or `vite preview` :4173 with
 * SW=1 to also check that the app opens offline from the service worker).
 *   node e2e/pos-offline.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = 'http://localhost:3000/api';
const SW = process.env.SW === '1';
let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
};
const api = async (p, body, tok, method) => {
  const r = await fetch(API + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

const run = Date.now().toString(36);
const reg = await api('/auth/register', { businessName: `Abarrotes ${run}`, businessType: 'other', name: 'Dueña Caja', email: `caja-${run}@test.mx`, password: 'password123' });
const tok = reg.token;
await api('/tenant/plan', { plan: 'standard' }, tok, 'PUT');
const gel = await api('/products', { name: 'Gel fijador', priceCents: 9000, initialStock: 5 }, tok);
const agua = await api('/products', { name: 'Agua natural', priceCents: 1500, trackStock: false }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-MX' });
await ctx.addCookies([{ name: 'lugali_session', value: tok, url: BASE }]);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(BASE + '/');
await page.evaluate(() => localStorage.setItem('agenda.session', '1'));
await page.goto(BASE + '/pos');
const products = page.getByTestId('pos-products');
await products.waitFor({ timeout: 15000 });
const tabs = page.getByTestId('pos-ticket-tab');
const total = async () => ((await page.getByTestId('pos-total').textContent()) ?? '').trim();

// ---- Several customers at once ----
await products.getByRole('button', { name: /Gel fijador/ }).click();
await products.getByRole('button', { name: /Gel fijador/ }).click();
ok('first customer: two gels on the ticket', /180/.test(await total()), await total());
await page.getByTestId('pos-new-ticket').click();
ok('next customer opens a second, empty ticket', (await tabs.count()) === 2 && /^\$0(\.00)?$/.test(await total()), `${await tabs.count()} ${await total()}`);
ok('the first ticket waits with its amount', /Cliente 1 · \$180/.test((await tabs.nth(0).textContent()) ?? ''), (await tabs.nth(0).textContent()) ?? '');
await products.getByRole('button', { name: /Agua natural/ }).click();
await page.getByTestId('pos-received').fill('20');
await page.getByTestId('pos-charge').click();
await page.getByTestId('pos-done').waitFor({ timeout: 10000 });
ok('the second customer pays first', /15/.test((await page.getByTestId('pos-done').textContent()) ?? ''));
await page.getByRole('button', { name: /Nueva venta/ }).click();
ok('after charging, back to the waiting ticket', (await tabs.count()) === 1 && /180/.test(await total()), `${await tabs.count()} ${await total()}`);
await page.reload();
await products.waitFor({ timeout: 15000 });
ok('waiting tickets survive a reload', /180/.test(await total()), await total());
// Discarding a ticket with products asks first
await page.getByTestId('pos-new-ticket').click();
await page.getByTestId('pos-ticket-discard').first().click();
ok('discarding a full ticket asks to confirm', (await page.getByTestId('pos-ticket-discard-yes').count()) === 1);
await page.getByTestId('pos-ticket-discard-yes').click();
ok('confirmed: only the empty ticket stays', (await tabs.count()) === 1 && /^\$0(\.00)?$/.test(await total()), await total());

// ---- Without internet ----
await page.getByTestId('pos-register').check();
await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('lugali.pos.catalog.')) && Object.keys(localStorage).some((k) => k.startsWith('lugali.pos.header.')), null, { timeout: 10000 }).catch(() => {});
ok('register keeps a copy of the catalog and ticket header', await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('lugali.pos.header.'))));

await ctx.setOffline(true);
await page.getByTestId('pos-offline-bar').waitFor({ timeout: 5000 }).catch(() => {});
ok('offline banner says you can keep selling', /Sin internet: sigues vendiendo/.test((await page.getByTestId('pos-offline-bar').textContent().catch(() => '')) ?? ''));
await products.getByRole('button', { name: /Gel fijador/ }).click();
await page.getByTestId('pos-method-card').click();
await page.getByTestId('pos-charge').click();
await page.getByTestId('pos-done-offline').waitFor({ timeout: 10000 }).catch(() => {});
ok('offline sale saved on the computer', await page.getByTestId('pos-done-offline').isVisible().catch(() => false), (await page.getByTestId('pos-ticket').textContent().catch(() => ''))?.slice(-300));
const doneTitle = (await page.locator('[role=dialog] h2, [role=dialog] h3').first().textContent().catch(() => '')) ?? '';
ok('with a provisional number', /P-0001/.test(doneTitle), doneTitle);
const [ticketPage] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.getByTestId('pos-print').click({ timeout: 5000 })]).catch(() => [null]);
if (!ticketPage) {
  console.log('no ticket window; stopping');
  await browser.close();
  process.exit(1);
}
if (SW) {
  // Only the production build (service worker) can open a page without internet
  await ticketPage.getByTestId('ticket').waitFor({ timeout: 10000 }).catch(() => {});
  const ticketText = (await ticketPage.getByTestId('ticket').textContent().catch(() => '')) ?? '';
  ok('offline ticket prints from the computer', ticketText.includes('Folio provisional P-0001') && ticketText.includes('Gel fijador') && ticketText.includes(`Abarrotes ${run}`), ticketText.slice(0, 160));
} else {
  ok('offline ticket opens the local copy', ticketPage.url().includes('/ticket/local/'), ticketPage.url());
}
await ticketPage.close();
await page.getByRole('button', { name: /Nueva venta/ }).click();
ok('pending sale listed and counted', /1 venta por subir/.test((await page.getByTestId('pos-offline-bar').textContent().catch(() => '')) ?? '') && /P-0001/.test((await page.getByTestId('pos-pending').textContent().catch(() => '')) ?? ''));

// Back online: it uploads itself
await ctx.setOffline(false);
await page.getByTestId('pos-pending').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
ok('back online the sale uploads itself', (await page.getByTestId('pos-pending').count()) === 0);
const sales = await api('/sales', undefined, tok);
const up = sales.find((s) => s.offline);
ok('the server has it once, marked offline, paid by card', sales.filter((s) => s.offline).length === 1 && up?.payments[0]?.method === 'card' && up?.totalCents === 9000, JSON.stringify(sales.map((s) => [s.number, s.offline, s.totalCents])));
const stock = (await api('/products', undefined, tok)).find((p) => p.id === gel.id)?.stock;
ok('stock went down for the offline sale', stock === 4, String(stock));
const local = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lugali.pos.queue.')).length);
ok('nothing left waiting on the computer', local === 0);

// ---- The app itself opens without internet (service worker; production build only) ----
if (SW) {
  await page.goto(BASE + '/pos');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  // Second load so the worker controls the page and keeps this version
  await page.reload();
  await products.waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await ctx.setOffline(true);
  await page.reload();
  await products.waitFor({ timeout: 15000 }).catch(() => {});
  ok('offline reload: the counter opens with the saved catalog', await products.getByRole('button', { name: /Agua natural/ }).isVisible().catch(() => false));
  await products.getByRole('button', { name: /Agua natural/ }).click().catch(() => {});
  await page.getByTestId('pos-charge').click().catch(() => {});
  await page.getByTestId('pos-done-offline').waitFor({ timeout: 10000 }).catch(() => {});
  ok('and keeps charging', await page.getByTestId('pos-done-offline').isVisible().catch(() => false));
  await ctx.setOffline(false);
  await page.getByRole('button', { name: /Nueva venta/ }).click().catch(() => {});
  await page.getByTestId('pos-pending').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  ok('and uploads it afterwards', (await api('/sales', undefined, tok)).filter((s) => s.offline).length === 2);
}

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
