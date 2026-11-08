// Browser smoke test of the deployed app with Playwright.
// Usage: BASE=https://agenda-crm-rouge.vercel.app node e2e/prod-ui.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://agenda-crm-rouge.vercel.app';
const out = process.env.OUT ?? '/vercel/shots';
const results = [];
let fail = 0;
const check = (name, ok, info = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : info}`);
  if (!ok) fail++;
};

const browser = await chromium.launch();
const errors = [];
async function run(viewport, label) {
  const ctx = await browser.newContext({ viewport, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`));

  await page.goto(`${BASE}/login`);
  await page.fill('#email', 'demo@agenda.mx');
  await page.fill('#password', 'demo1234');
  await page.click('button[type=submit], form button');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  await page.getByText('Ingresos por mes').waitFor({ timeout: 15000 }).catch(() => {});
  check(`[${label}] login -> dashboard`, await page.getByText('Ingresos por mes').isVisible());
  await page.waitForTimeout(1500);
  check(`[${label}] charts render (svg bars)`, (await page.locator('.recharts-bar-rectangle').count()) > 0);
  await page.screenshot({ path: `${out}/${label}-dashboard.png`, fullPage: true });

  await page.goto(`${BASE}/agenda`);
  await page.getByRole('heading', { name: 'Agenda' }).waitFor();
  await page.waitForTimeout(1000);
  check(`[${label}] agenda shows appointments`, (await page.locator('main button:has(span.rounded-full)').count()) > 0);
  await page.screenshot({ path: `${out}/${label}-agenda.png`, fullPage: true });

  await page.goto(`${BASE}/customers`);
  await page.getByRole('heading', { name: 'Clientes' }).waitFor();
  await page.waitForTimeout(800);
  check(`[${label}] customers table`, (await page.locator('tbody tr').count()) >= 20);
  await page.locator('tbody tr a').first().click();
  await page.getByText('Historial de citas').waitFor({ timeout: 10000 }).catch(() => {});
  check(`[${label}] customer detail`, await page.getByText('Historial de citas').isVisible());
  await page.screenshot({ path: `${out}/${label}-customer.png`, fullPage: true });

  await page.goto(`${BASE}/services`);
  await page.getByRole('heading', { name: 'Servicios' }).waitFor();
  await page.getByText('Consulta inicial').first().waitFor({ timeout: 10000 }).catch(() => {});
  check(`[${label}] services page`, await page.getByText('Consulta inicial').first().isVisible());

  await page.goto(`${BASE}/payments`);
  await page.getByRole('heading', { name: 'Pagos' }).waitFor();
  check(`[${label}] payments page`, await page.getByText('Cobrado').isVisible());

  await page.goto(`${BASE}/settings`);
  await page.getByRole('heading', { name: 'Configuración' }).waitFor();
  check(`[${label}] settings page`, await page.getByText('Tu página de reservas').isVisible());
  await page.getByText('Métodos de pago').scrollIntoViewIfNeeded();
  check(`[${label}] settings: payment methods section`, await page.getByText('Métodos de pago').isVisible());
  check(`[${label}] settings: deposit section`, await page.getByText('Anticipo para reservar').isVisible());
  check(`[${label}] settings: CLABE prefilled`, (await page.locator('input[value="012180001234567899"]').count()) === 1);
  await page.screenshot({ path: `${out}/${label}-settings.png`, fullPage: true });

  // language switch
  await page.locator('button:visible:text-is("EN")').first().click();
  await page.waitForTimeout(300);
  check(`[${label}] switch to English`, await page.getByRole('heading', { name: 'Settings' }).isVisible());
  await page.locator('button:visible:text-is("ES")').first().click();

  // public booking page
  await page.goto(`${BASE}/b/nutricion-demo`);
  await page.getByText('Agenda tu cita').waitFor();
  await page.getByText('Consulta de seguimiento').click();
  await page.waitForTimeout(500);
  const days = page.locator('section:has-text("Elige el día") button');
  check(`[${label}] booking: days shown`, (await days.count()) > 5);
  await days.nth(6).click();
  await page.waitForTimeout(1500);
  check(`[${label}] booking: times shown`, (await page.locator('section:has-text("Elige la hora") button').count()) > 0);
  check(`[${label}] booking: deposit shown on services`, (await page.getByText(/Anticipo: \$/).count()) > 0);
  await page.screenshot({ path: `${out}/${label}-booking.png`, fullPage: true });
  if (label === 'desktop') {
    await page.locator('section:has-text("Elige la hora") button').last().click();
    await page.fill('input[type=tel]', '5512340000');
    await page.locator('input[minlength="2"]').fill('Prueba UI Anticipo');
    await page.getByRole('button', { name: 'Confirmar cita' }).click();
    await page.getByText('Anticipo pendiente').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] booking: deposit box with CLABE`, await page.getByText('012180001234567899').isVisible());
    await page.screenshot({ path: `${out}/${label}-booking-done.png`, fullPage: true });
  }

  // logout
  await page.goto(`${BASE}/`);
  if (label === 'desktop') {
    await page.getByText('Cerrar sesión').click();
    await page.waitForURL(`${BASE}/login`);
    check(`[${label}] logout`, page.url().endsWith('/login'));
  }
  await ctx.close();
}

await run({ width: 1366, height: 900 }, 'desktop');
await run({ width: 390, height: 844 }, 'mobile');
await browser.close();
check('no JS errors in browser', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(results.join('\n'));
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
