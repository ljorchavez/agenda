/**
 * Customer invoicing details: upload the SAT constancia (PDF), the fields fill in, save, see the card.
 * Needs the API on :3000 and the web on :5173 with the demo data, and Playwright: node e2e/fiscal.mjs
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const out = [];
const ok = (name, cond, info = '') => out.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : info}`);

/** One-page PDF with a text layer (Helvetica, WinAnsi), like the SAT's. */
function pdf(lines) {
  const esc = (l) => l.replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 9 Tf 20 800 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -14 Td`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let s = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(s, 'latin1')); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(s, 'latin1');
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s, 'latin1');
}
const file = '/tmp/csf-moral.pdf';
writeFileSync(file, pdf([
  'CONSTANCIA DE SITUACIÓN FISCAL',
  'RFC: CDP120101XY9',
  'Denominación/Razón Social: CAFÉ DEL PUERTO Régimen Capital: SOCIEDAD ANONIMA DE CAPITAL VARIABLE',
  'Fecha inicio de operaciones: 01 DE ENERO DE 2012 Estatus en el padrón: ACTIVO Fecha de último cambio',
  'Código Postal:06600',
  'Regímenes: Régimen Fecha Inicio Régimen General de Ley Personas Morales 01/01/2012',
  'Obligaciones: Declaración anual',
]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, locale: 'es-MX' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?login=1');
await page.fill('#email', 'demo@lugali.com');
await page.fill('#password', 'demo1234');
await page.locator('form .btn-primary').first().click();
await page.waitForURL(/\/agenda/);

// Existing customer: edit → upload constancia → fields filled → save → card
await page.goto('http://localhost:5173/customers');
await page.locator('a[href^="/customers/"]').first().click();
await page.waitForSelector('[data-testid=fiscal-summary]');
ok('detail shows the invoicing card', (await page.locator('[data-testid=fiscal-summary]').count()) === 1);
await page.locator('[data-testid=fiscal-summary] button').first().click();
await page.setInputFiles('[data-testid=fiscal-file]', file);
await page.waitForSelector('[data-testid=fiscal-read]');
ok('RFC filled from the PDF', (await page.inputValue('[data-testid=fiscal-rfc]')) === 'CDP120101XY9', await page.inputValue('[data-testid=fiscal-rfc]'));
ok('legal name without régimen capital', (await page.inputValue('[data-testid=fiscal-name]')) === 'CAFÉ DEL PUERTO', await page.inputValue('[data-testid=fiscal-name]'));
ok('zip filled', (await page.inputValue('[data-testid=fiscal-zip]')) === '06600');
ok('regime picked', (await page.inputValue('[data-testid=fiscal-regime]')) === '601');
ok('says the file was not kept (no private store here)', /no se guardó/.test(await page.locator('[data-testid=fiscal-read]').innerText()));
await page.locator('.btn-primary', { hasText: 'Guardar' }).last().click();
await page.waitForSelector('[data-testid=fiscal-summary-rfc]');
ok('card shows the saved RFC', (await page.locator('[data-testid=fiscal-summary-rfc]').innerText()) === 'CDP120101XY9');

// A photo: can't be read, said so, fields stay as they were
await page.locator('[data-testid=fiscal-summary] button').first().click();
writeFileSync('/tmp/csf.jpg', Buffer.from([255, 216, 255, 224]));
await page.setInputFiles('[data-testid=fiscal-file]', '/tmp/csf.jpg');
await page.waitForSelector('[data-testid=fiscal-read]');
ok('photo: asks for the SAT PDF or typing', /No pudimos leer/.test(await page.locator('[data-testid=fiscal-read]').innerText()));
ok('photo: keeps saved data', (await page.inputValue('[data-testid=fiscal-rfc]')) === 'CDP120101XY9');
// Clearing the RFC removes the data
await page.fill('[data-testid=fiscal-rfc]', '');
await page.locator('.btn-primary', { hasText: 'Guardar' }).last().click();
await page.waitForTimeout(800);
ok('cleared RFC removes the data', (await page.locator('[data-testid=fiscal-summary-rfc]').count()) === 0);

// New customer: read before saving, kept with the customer
await page.goto('http://localhost:5173/customers');
await page.getByRole('button', { name: /Nuevo (cliente|paciente)/ }).first().click();
await page.locator('.modal input[required], [role=dialog] input[required]').first().fill('Cliente Fiscal E2E');
await page.setInputFiles('[data-testid=fiscal-file]', file);
await page.waitForSelector('[data-testid=fiscal-read]');
ok('new customer: fields filled', (await page.inputValue('[data-testid=fiscal-rfc]')) === 'CDP120101XY9');
await page.locator('.btn-primary', { hasText: 'Guardar' }).last().click();
await page.waitForURL(/\/customers\/[0-9a-f-]{36}/);
await page.waitForSelector('[data-testid=fiscal-summary-rfc]');
ok('new customer saved with RFC', (await page.locator('[data-testid=fiscal-summary-rfc]').innerText()) === 'CDP120101XY9');

ok('no page errors', errors.length === 0, errors.join(' | '));
console.log(out.join('\n'));
await browser.close();
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
