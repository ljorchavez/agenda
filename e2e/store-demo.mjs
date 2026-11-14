/**
 * The point-of-sale-only demo (MIV Mantenimiento, Sayer paints): its own login lands on the
 * point of sale, the menu has no agenda, and it has catalogue, customers, sales and cash closings.
 */
import { chromium } from 'playwright';
const API = 'http://localhost:3000/api';
const api = async (p, body, tok) => (await fetch(API + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; }));
const out = [];
const ok = (name, cond, info = '') => out.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : info}`);
const errors = [];

const login = await api('/auth/login', { email: 'miv@lugali.com', password: 'demo1234' });
const tok = login?.token;
ok('store login works', Boolean(tok) && login.tenant?.name === 'MIV Mantenimiento', JSON.stringify(login).slice(0, 200));
ok('agenda is off', login.tenant?.settings?.bookings?.enabled === false);
const prods = (await api('/products', null, tok)) ?? [];
ok('Sayer catalogue', prods.filter((p) => /Sayer/.test(p.name)).length >= 40, String(prods.length));
ok('products have barcodes and categories', prods.every((p) => /^750\d{10}$/.test(p.sku ?? '') && p.category));
ok('something runs low', prods.some((p) => p.low));
const custs = (await api('/customers?limit=200', null, tok)) ?? [];
const list = Array.isArray(custs) ? custs : custs.items ?? custs.rows ?? [];
ok('20 customers with RFC', list.filter((c) => c.fiscal?.rfc).length === 20, String(list.length));
const from = new Date(Date.now() - 160 * 86400e3).toISOString();
const sales = (await api(`/sales?from=${encodeURIComponent(from)}`, null, tok)) ?? [];
ok('months of sales', sales.length >= 1000, String(sales.length));
ok('sales with and without customer', sales.some((s) => s.customerName) && sales.some((s) => !s.customerName));
const closings = (await api('/cash/closings', null, tok)) ?? [];
const alerts = (await api('/pos/alerts', null, tok)) ?? [];
ok('alerts: cash differences, discounts and shrinkage', ['cash_diff', 'discounts', 'shrinkage'].every((k) => alerts.some((a) => a.kind === k)), alerts.map((a) => a.kind).join(','));
ok('AI is off without a key', (await api('/products/ai', null, tok))?.enabled === false);
ok('a cash closing per day', closings.length > 100, String(closings.length));

// No-show risk on the agenda (barbershop demo has a customer who often misses)
const rec = await api('/auth/login', { email: 'recepcion@lugali.com', password: 'demo1234' });
const soon = (await api(`/appointments?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 12 * 86400e3).toISOString())}`, null, rec?.token)) ?? [];
ok('agenda flags a likely no-show', soon.some((a) => a.noShowRisk?.reasons?.includes('past_no_shows')), String(soon.length));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, locale: 'es-MX' });
page.on('pageerror', (e) => { if (!/_leaflet_pos/.test(e.message)) errors.push(e.message); });
await page.goto('http://localhost:5173/?login=1');
await page.fill('#email', 'miv@lugali.com');
await page.fill('#password', 'demo1234');
await page.locator('form .btn-primary').first().click();
await page.waitForURL(/\/pos/, { timeout: 15000 }).catch(() => {});
ok('login lands on the point of sale', /\/pos/.test(page.url()), page.url());
ok('no agenda or services in the menu', (await page.locator('nav a[href="/agenda"]').count()) === 0 && (await page.locator('nav a[href="/services"]').count()) === 0);
await page.goto('http://localhost:5173/pos?tab=products');
await page.getByTestId('product-row').first().waitFor({ timeout: 10000 }).catch(() => {});
ok('products listed', (await page.getByTestId('product-row').count()) >= 20);
await page.goto('http://localhost:5173/pos?tab=reports');
await page.getByTestId('pos-alerts').waitFor({ timeout: 10000 }).catch(() => {});
ok('alerts shown above the reports', (await page.locator('[data-testid^=pos-alert-]').count()) >= 3);
await page.goto('http://localhost:5173/pos?tab=sales');
await page.getByTestId('sales-row').first().waitFor({ timeout: 10000 }).catch(() => {});
// History opens on today: rows match what was sold today (none yet early in the morning)
const midnight = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
const todayCount = sales.filter((x) => new Date(x.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) === midnight.toLocaleDateString('en-CA')).length;
ok('history shows today', todayCount === 0 || (await page.getByTestId('sales-row').count()) > 0, String(todayCount));
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = out.filter((l) => l.startsWith('FAIL')).length;
console.log(out.join('\n'));
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
