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
ok('POS tabs: Vender, Historial, Productos, Corte de caja, Reportes', ['Vender', 'Historial', 'Productos', 'Corte de caja', 'Reportes'].every((x) => posTabs.includes(x)), posTabs.join(','));
ok('Vender no longer lists today\'s sales', (await page.getByTestId('pos-sales').count()) === 0 && (await page.getByTestId('pos-register').count()) === 0);
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

await page.getByTestId('products-import').click();
await page.setInputFiles('[data-testid=import-file]', xlsxPath);
await page.getByTestId('import-summary').waitFor({ timeout: 10000 });
ok('same file back (only the filtered product): nothing to change', /0 y se actualizarán 0 productos \(1 sin cambios\)/.test((await page.getByTestId('import-summary').textContent()) ?? '') && (await page.getByTestId('import-apply').count()) === 0, (await page.getByTestId('import-summary').textContent()) ?? '');

const csv = `ID,Producto,Precio,Existencia,Categoría\n${gel.number},Gel fijador,99,12,Cabello\n,Cera mate,"$120.00",4,Cabello\n,Sin precio,,1,\n`;
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
await page.getByTestId('import-modal').getByRole('button', { name: 'Cerrar', exact: true }).click();
await page.waitForTimeout(500);
ok('list refreshed', (await page.getByTestId('product-row').filter({ hasText: 'Cera mate' }).count()) === 1);

// ---- Columns: hide and reorder (kept in this browser) ----
ok('products show the ID number', /#1(?!\d)/.test((await page.getByTestId('product-row').filter({ hasText: 'Gel fijador' }).textContent()) ?? '') && /#3(?!\d)/.test((await page.getByTestId('product-row').filter({ hasText: 'Cera mate' }).textContent()) ?? ''));
await page.getByTestId('cols-products').click();
await page.getByTestId('col-toggle-sku').click();
ok('switch turns a column off', !(await page.locator('[data-testid=col-toggle-sku] input').isChecked()));
// Drag "Precio" above "Categoría" with the grip
{
  const from = await page.getByTestId('col-drag-price').boundingBox();
  const to = await page.getByTestId('col-row-category').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y - 5, { steps: 5 });
  await page.mouse.move(to.x + 10, to.y + 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
await page.keyboard.press('Escape');
const heads = async () => (await page.locator('[data-testid=products-tab] thead th').allTextContents()).map((x) => x.trim().toLowerCase());
let h = await heads();
ok('hide a column', !h.includes('sku'), h.join(','));
ok('move a column', h.indexOf('precio') >= 0 && h.indexOf('precio') < h.indexOf('categoría'), h.join(','));
const priceBefore = h.indexOf('precio');
await page.reload();
await page.getByTestId('product-row').first().waitFor({ timeout: 10000 });
h = await heads();
ok('column choice kept after reload', !h.includes('sku') && h.indexOf('precio') === priceBefore, h.join(','));

// ---- Reports inside Punto de venta ----
await page.getByTestId('pos-tab-reports').click();
await page.getByTestId('reports-pos').waitFor({ timeout: 10000 }).catch(() => {});
await page.getByTestId('pos-kpis').waitFor({ timeout: 10000 }).catch(() => {});
ok('POS reports: only point-of-sale blocks', await page.getByTestId('pos-kpis').isVisible().catch(() => false) && (await page.getByText('Citas en el tiempo').count()) === 0);

// ---- Settings: categories and what happens without stock ----
await page.getByTestId('pos-tab-products').click();
await page.getByTestId('pos-settings-open').click();
await page.getByTestId('category-new').fill('Barba');
await page.getByTestId('category-add').click();
await page.waitForTimeout(500);
ok('add a category', /Barba/.test((await page.getByTestId('category-list').textContent()) ?? ''));
await page.getByTestId('category-list').locator('li', { hasText: 'Cabello' }).getByTestId('category-rename').click();
await page.getByTestId('category-rename-input').fill('Pelo');
await page.getByTestId('category-rename-input').press('Enter');
await page.waitForTimeout(800);
const afterRename = await api('/products', undefined, tok);
ok('renaming a category changes its products', afterRename.filter((p) => p.category === 'Pelo').length === 2 && !afterRename.some((p) => p.category === 'Cabello'), afterRename.map((p) => p.category).join(','));
await page.getByTestId('stock-policy-warn').check();
await page.waitForTimeout(500);
ok('stock policy saved', (await api('/pos/settings', undefined, tok)).stockPolicy === 'warn');
await page.getByTestId('pos-settings').getByRole('button', { name: 'Cerrar', exact: true }).click();

// ---- New product: category list, suggested SKU, SAT key search ----
await page.getByTestId('new-product').click();
await page.getByTestId('product-form').locator('input[required]').first().fill('Aceite para barba 30 ml');
const catOptions = await page.getByTestId('product-category-select').locator('option').allTextContents();
ok('category is a list (with the new ones)', ['Barba', 'Pelo', 'Bebidas'].every((c) => catOptions.includes(c)), catOptions.join(','));
await page.getByTestId('product-category-select').selectOption('Barba');
await page.getByTestId('pf-sku-suggest').click();
ok('suggested SKU from the name', (await page.getByTestId('pf-sku').inputValue()) === 'ACE-BAR-30ML', await page.getByTestId('pf-sku').inputValue());
await page.getByTestId('pf-sku').fill('7501234567890');
await page.getByTestId('pf-sat-search').click();
await page.getByTestId('sat-results').getByText('No existe en el catálogo').waitFor({ timeout: 8000 }).catch(() => {});
await page.getByTestId('sat-results').getByText('No existe en el catálogo').click();
ok('SAT key picked from the list', (await page.getByTestId('pf-sat').inputValue()) === '01010101');
await page.getByTestId('product-form').locator('input[type=number]').first().fill('150');
await page.getByTestId('product-form').getByRole('button', { name: 'Guardar' }).click();
await page.waitForTimeout(800);
const aceite = (await api('/products', undefined, tok)).find((p) => p.name === 'Aceite para barba 30 ml');
ok('product saved with category, barcode and SAT key', aceite?.category === 'Barba' && aceite?.sku === '7501234567890' && aceite?.satKey === '01010101', JSON.stringify(aceite));

// ---- Selling: barcode scanner, remove a line, sell without stock (warn) ----
await page.getByTestId('pos-tab-sell').click();
await page.getByTestId('pos-products').waitFor({ timeout: 10000 });
await page.getByTestId('pos-search').fill('7501234567890');
await page.getByTestId('pos-search').press('Enter');
ok('typing/scanning the code + Enter adds it', /Aceite para barba/.test((await page.getByTestId('pos-ticket').textContent()) ?? '') && (await page.getByTestId('pos-search').inputValue()) === '');
// A USB scanner types fast anywhere on the page
await page.locator('h1').click();
await page.keyboard.type('7501234567890\n', { delay: 5 });
await page.waitForTimeout(300);
ok('scanner anywhere adds another', (await page.getByTestId('pos-qty').first().textContent()) === '2', (await page.getByTestId('pos-qty').first().textContent()) ?? '');
await page.getByTestId('pos-remove-line').first().click();
ok('✕ removes the line', (await page.getByTestId('pos-remove-line').count()) === 0);
// Quantities: ×3 then click, double click to type, 10*code
await page.getByTestId('pos-mult').fill('3');
await page.getByTestId('pos-products').getByRole('button', { name: /Agua natural/ }).click();
ok('×3 then click adds 3', (await page.getByTestId('pos-qty').first().textContent()) === '3' && (await page.getByTestId('pos-mult').inputValue()) === '');
await page.getByTestId('pos-qty').first().dblclick();
await page.getByTestId('pos-qty-input').fill('10');
await page.getByTestId('pos-qty-input').press('Enter');
ok('double click the quantity to type 10', (await page.getByTestId('pos-qty').first().textContent()) === '10');
ok('no price box in each line', (await page.getByTestId('pos-cart').locator('input').count()) === 0);
await page.getByTestId('pos-line-price').first().dblclick();
await page.getByTestId('pos-line-price-input').fill('12');
await page.getByTestId('pos-line-price-input').press('Enter');
ok('double click the amount to change the price', /\$120/.test((await page.getByTestId('pos-total').textContent()) ?? ''), (await page.getByTestId('pos-total').textContent()) ?? '');
await page.getByTestId('pos-remove-line').first().click();
await page.getByTestId('pos-search').fill('4*7501234567890');
await page.getByTestId('pos-search').press('Enter');
ok('4*code adds 4', (await page.getByTestId('pos-qty').first().textContent()) === '4');
await page.getByTestId('pos-remove-line').first().click();
ok('the ticket list scrolls on its own', /overflow-y-auto/.test((await page.getByTestId('pos-cart').getAttribute('class').catch(() => '')) ?? '') || (await page.getByTestId('pos-cart').count()) === 0);
// Unknown code: create the product from there
await page.getByTestId('pos-search').fill('0000000000017');
await page.getByTestId('pos-search').press('Enter');
await page.getByTestId('pos-create-from-code').click();
ok('new product starts with the scanned code', (await page.getByTestId('pf-sku').inputValue()) === '0000000000017');
await page.getByTestId('pf-lookup-result').waitFor({ timeout: 12000 }).catch(() => {});
ok('looked it up online', (await page.getByTestId('pf-lookup-result').count()) === 1);
await page.getByTestId('product-form').locator('input[required]').first().fill('Producto escaneado');
await page.getByTestId('product-form').locator('input[type=number]').first().fill('25');
await page.getByTestId('product-form').getByRole('button', { name: 'Guardar' }).click();
await page.waitForTimeout(800);
await page.getByTestId('pos-search').fill('0000000000017');
await page.getByTestId('pos-search').press('Enter');
ok('then scanning it sells it', /Producto escaneado/.test((await page.getByTestId('pos-ticket').textContent()) ?? ''));
await page.getByTestId('pos-remove-line').first().click();
// Aceite has no stock (0): with "warn" it sells with a notice
await page.getByTestId('pos-products').getByRole('button', { name: /Aceite para barba/ }).click();
ok('out of stock can be sold with a notice', await page.getByTestId('pos-stock-warn').isVisible().catch(() => false));
await page.getByTestId('pos-charge').click();
await page.getByTestId('pos-done').waitFor({ timeout: 10000 }).catch(() => {});
ok('sale without stock went through', await page.getByTestId('pos-done').isVisible().catch(() => false));
ok('stock went below zero', (await api('/products', undefined, tok)).find((p) => p.name === 'Aceite para barba 30 ml')?.stock === -1);
await page.getByRole('button', { name: /Nueva venta/ }).click();

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
