/**
 * Punto de venta tabs (Vender, Ventas, Productos, Corte de caja), editing products with a double
 * click, inventory to and from Excel, and the source column in Cobros → Movimientos.
 * Needs the API on :3000 and the web on :5173, and Playwright: node e2e/pos-inventory.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = 'http://localhost:3000/api';
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
const reg = await api('/auth/register', { businessName: `Tienda ${run}`, businessType: 'barbershop', name: 'Dueño Inventario', email: `inv-${run}@test.mx`, password: 'password123' });
const tok = reg.token;
await api('/tenant/plan', { plan: 'standard' }, tok, 'PUT');
const gel = await api('/products', { name: 'Gel', priceCents: 9000, initialStock: 5, category: 'Cabello' }, tok);
await api('/products', { name: 'Agua natural', priceCents: 1500, trackStock: false, category: 'Bebidas' }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, locale: 'es-MX', acceptDownloads: true });
await ctx.addCookies([{ name: 'lugali_session', value: tok, url: BASE }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/');
await page.evaluate(() => localStorage.setItem('agenda.session', '1'));

// ---- Cobros no longer sells; old links go to Punto de venta ----
await page.goto(BASE + '/payments');
await page.getByRole('tab', { name: 'Movimientos' }).waitFor({ timeout: 15000 });
const cobrosTabs = await page.getByRole('tab').allTextContents();
ok('Cobros without Vender and Productos', !cobrosTabs.some((x) => /Vender|Productos/.test(x)), cobrosTabs.join(','));
await page.goto(BASE + '/payments?tab=products');
await page.waitForURL(/\/pos\?tab=products/, { timeout: 10000 }).catch(() => {});
ok('old Productos link opens it in Punto de venta', /\/pos\?tab=products/.test(page.url()), page.url());

// ---- Punto de venta tabs ----
await page.goto(BASE + '/pos');
const products = page.getByTestId('pos-products');
await products.waitFor({ timeout: 15000 });
const posTabs = (await page.getByRole('tab').allTextContents()).map((x) => x.trim());
ok('POS tabs: Vender, Ventas, Productos, Corte de caja', ['Vender', 'Ventas', 'Productos', 'Corte de caja'].every((x) => posTabs.includes(x)), posTabs.join(','));
await products.getByRole('button', { name: /Gel/ }).click();
await products.getByRole('button', { name: /Agua natural/ }).click();
await page.getByTestId('pos-method-credit_card').click();
await page.getByTestId('pos-charge').click();
await page.getByTestId('pos-done').waitFor({ timeout: 10000 });
await page.getByRole('button', { name: /Nueva venta/ }).click();

await page.getByTestId('pos-tab-sales').click();
await page.getByTestId('sales-row').first().waitFor({ timeout: 10000 });
ok('Ventas shows today by default', (await page.getByTestId('sales-row').count()) === 1 && (await page.getByTestId('sales-preset').inputValue()) === 'today');
ok('totals of the period', /\$105/.test((await page.getByTestId('sales-totals').textContent()) ?? ''), (await page.getByTestId('sales-totals').textContent()) ?? '');
await page.getByTestId('sales-search').fill('#1');
ok('find by ticket number', (await page.getByTestId('sales-row').count()) === 1);
await page.getByTestId('sales-search').fill('agua');
ok('find by product in the ticket', (await page.getByTestId('sales-row').count()) === 1);
await page.getByTestId('sales-search').fill('shampoo');
ok('no match by product', (await page.getByTestId('sales-row').count()) === 0);
await page.getByTestId('sales-search').fill('');
await page.getByRole('button', { name: /Filtros|Más filtros/ }).first().click().catch(() => {});
await page.getByTestId('sales-invoiced').selectOption('yes').catch(() => {});
ok('invoiced filter: none invoiced', (await page.getByTestId('sales-row').count()) === 0);
await page.getByTestId('sales-invoiced').selectOption('no').catch(() => {});
ok('not invoiced: the sale', (await page.getByTestId('sales-row').count()) === 1);
await page.getByTestId('sales-preset').selectOption('yesterday');
await page.waitForTimeout(800);
ok('yesterday: no sales', (await page.getByTestId('sales-row').count()) === 0);
await page.getByTestId('sales-preset').selectOption('custom');
ok('pick any dates', (await page.getByTestId('sales-from').count()) === 1 && (await page.getByTestId('sales-to').count()) === 1);

// ---- Products: double click to edit ----
await page.getByTestId('pos-tab-products').click();
await page.getByTestId('product-row').first().waitFor({ timeout: 10000 });
const gelRow = page.getByTestId('product-row').filter({ hasText: 'Gel' });
await gelRow.getByTestId('product-name').dblclick();
await page.getByTestId('product-name-input').fill('Gel fijador');
await page.getByTestId('product-name-input').press('Enter');
await page.waitForTimeout(800);
await gelRow.getByTestId('product-price').dblclick();
await page.getByTestId('product-price-input').fill('95.50');
await page.getByTestId('product-price-input').press('Enter');
await page.waitForTimeout(800);
await gelRow.getByTestId('product-stock').dblclick();
await page.getByTestId('product-stock-input').fill('7');
await page.getByTestId('product-stock-input').press('Enter');
await page.waitForTimeout(800);
let saved = (await api('/products', undefined, tok)).find((p) => p.id === gel.id);
ok('double click: name changed', saved?.name === 'Gel fijador', saved?.name);
ok('double click: price changed', saved?.priceCents === 9550, String(saved?.priceCents));
ok('double click: stock counted', saved?.stock === 7, String(saved?.stock));
await gelRow.getByTestId('product-name').dblclick();
await page.getByTestId('product-name-input').fill('No se guarda');
await page.getByTestId('product-name-input').press('Escape');
await page.waitForTimeout(400);
ok('Esc cancels the edit', (await api('/products', undefined, tok)).find((p) => p.id === gel.id)?.name === 'Gel fijador');

// ---- Excel: filtered download, upload as is, upload with changes ----
await page.getByTestId('products-category').selectOption('Cabello');
ok('filter by category', (await page.getByTestId('product-row').count()) === 1);
ok('download says how many', /\(1\)/.test((await page.getByTestId('products-export').textContent()) ?? ''), (await page.getByTestId('products-export').textContent()) ?? '');
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('products-export').click()]);
const xlsxPath = '/tmp/inventario-e2e.xlsx';
await dl.saveAs(xlsxPath);
const bytes = readFileSync(xlsxPath);
ok('downloaded an .xlsx (zip)', /\.xlsx$/.test(dl.suggestedFilename()) && bytes[0] === 0x50 && bytes[1] === 0x4b, dl.suggestedFilename());
ok('only the filtered products', bytes.includes(Buffer.from('Gel fijador')) && !bytes.includes(Buffer.from('Agua natural')));

await page.getByTestId('products-import').click();
await page.setInputFiles('[data-testid=import-file]', xlsxPath);
await page.getByTestId('import-summary').waitFor({ timeout: 10000 });
ok('same file back: nothing to change', /0 y se actualizarán 0/.test((await page.getByTestId('import-summary').textContent()) ?? '') && (await page.getByTestId('import-apply').count()) === 0, (await page.getByTestId('import-summary').textContent()) ?? '');

const csv = `ID,Producto,Precio,Existencia,Categoría\n${gel.id},Gel fijador,99,12,Cabello\n,Cera mate,"$120.00",4,Cabello\n,Sin precio,,1,\n`;
writeFileSync('/tmp/inventario-e2e.csv', csv);
await page.setInputFiles('[data-testid=import-file]', '/tmp/inventario-e2e.csv');
await page.getByTestId('import-apply').waitFor({ timeout: 10000 });
ok('preview: 1 new, 1 update, 1 error', (await page.getByTestId('import-row-create').count()) === 1 && (await page.getByTestId('import-row-update').count()) === 1 && (await page.getByTestId('import-row-error').count()) === 1);
ok('the error says why', /Falta el precio/.test((await page.getByTestId('import-row-error').textContent()) ?? ''));
await page.getByTestId('import-apply').click();
await page.getByText(/Listo: 1 creados y 1 actualizados/).waitFor({ timeout: 10000 }).catch(() => {});
ok('applied', /Listo/.test((await page.getByTestId('import-summary').textContent()) ?? ''));
const after = await api('/products', undefined, tok);
ok('update by ID: price and stock', after.find((p) => p.id === gel.id)?.priceCents === 9900 && after.find((p) => p.id === gel.id)?.stock === 12);
ok('new product created with stock', after.find((p) => p.name === 'Cera mate')?.stock === 4);
await page.getByRole('button', { name: 'Cerrar' }).click();
await page.waitForTimeout(500);
ok('list refreshed', (await page.getByTestId('product-row').filter({ hasText: 'Cera mate' }).count()) === 1);

// ---- Corte de caja in POS ----
await page.getByTestId('pos-tab-cash').click();
await page.getByTestId('cash-tab').waitFor({ timeout: 10000 }).catch(() => {});
ok('Corte de caja inside Punto de venta', await page.getByTestId('cash-tab').isVisible().catch(() => false));

// ---- Cobros → Movimientos: where each one comes from ----
const cu = await api('/customers', { name: 'Cliente Reserva', phone: '5512349988' }, tok);
await api('/payments', { customerId: cu.id, amountCents: 30000, method: 'cash', status: 'paid' }, tok);
await page.goto(BASE + '/payments?tab=movements');
await page.getByTestId('movement-origin').first().waitFor({ timeout: 10000 });
const origins = await page.getByTestId('movement-origin').allTextContents();
ok('source column', origins.some((x) => /Punto de venta/.test(x)) && origins.some((x) => /Otros/.test(x)), origins.join(','));
await page.getByRole('button', { name: /Filtros|Más filtros/ }).first().click().catch(() => {});
await page.getByTestId('filter-origin').selectOption('pos');
const onlyPos = await page.getByTestId('movement-origin').allTextContents();
ok('filter by source', onlyPos.length > 0 && onlyPos.every((x) => /Punto de venta/.test(x)), onlyPos.join(','));

ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
