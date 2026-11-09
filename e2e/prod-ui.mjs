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

  await page.goto(`${BASE}/reports`);
  await page.getByRole('heading', { name: 'Reportes' }).waitFor();
  await page.getByText('Ingresos cobrados').waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  check(`[${label}] reports: KPIs`, await page.getByText('Ingresos cobrados').isVisible());
  check(`[${label}] reports: charts render`, (await page.locator('.recharts-bar-rectangle').count()) > 10);
  check(`[${label}] reports: heatmap`, (await page.locator('td[title]').count()) > 20);
  await page.locator('select').first().selectOption('last12Months');
  await page.waitForTimeout(2500);
  check(`[${label}] reports: 12-month view`, page.url().includes('p=last12Months') && (await page.locator('.recharts-bar-rectangle').count()) > 10);
  await page.screenshot({ path: `${out}/${label}-reports.png`, fullPage: true });

  await page.goto(`${BASE}/settings`);
  await page.getByRole('heading', { name: 'Configuración' }).waitFor();
  check(`[${label}] settings page`, await page.getByRole('heading', { name: 'Tu página de reservas' }).isVisible());
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
    await page.getByText('Administrar mi cita').click();
    await page.getByText('Cambiar fecha u hora').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] manage page opens`, await page.getByText('Cambiar fecha u hora').isVisible());
    await page.getByText('Cambiar fecha u hora').click();
    const mdays = page.locator('section:has-text("Elige el día") button');
    await mdays.nth(7).click();
    await page.waitForTimeout(1500);
    await page.locator('section:has-text("Elige la hora") button').first().click();
    await page.getByRole('button', { name: 'Confirmar cambio' }).click();
    await page.getByText('Tu cita se cambió').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] customer reschedules from link`, await page.getByText('Tu cita se cambió').isVisible());
    await page.screenshot({ path: `${out}/${label}-manage.png`, fullPage: true });
    await page.getByRole('button', { name: 'Cancelar cita' }).click();
    await page.getByRole('button', { name: 'Sí, cancelar' }).click();
    await page.getByText('Tu cita fue cancelada').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] customer cancels from link`, await page.getByText('Tu cita fue cancelada').isVisible());
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

const pinTotal = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section .leaflet-marker-icon')].reduce(
      (a, el) => a + Number(el.querySelector('[data-count]')?.getAttribute('data-count') ?? 1),
      0,
    ),
  );

async function publicPages(viewport, label) {
  const ctx = await browser.newContext({ viewport, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/tile\.openstreetmap/.test(m.text()) && errors.push(`${label} console: ${m.text()}`));
  const mobile = viewport.width < 1024;
  const showMap = async () => { if (mobile) await page.getByRole('tab', { name: 'Mapa' }).click(); };

  // Directory with map
  await page.goto(`${BASE}/directorio`);
  await page.getByText('Encuentra y reserva').waitFor({ timeout: 15000 });
  await page.getByText(/\d+ negocios/).first().waitFor({ timeout: 15000 });
  const total = Number((await page.getByText(/\d+ negocios/).first().textContent()).match(/\d+/)[0]);
  check(`[${label}] directory lists businesses`, total >= 15, total);
  await page.screenshot({ path: `${out}/${label}-directory-list.png`, fullPage: false });
  await showMap();
  await page.locator('.leaflet-marker-icon').first().waitFor({ timeout: 15000 }).catch(() => {});
  const pins = await pinTotal(page);
  check(`[${label}] map shows every business (pins + bubbles)`, pins === total, `${pins}/${total}`);
  check(`[${label}] dense areas are grouped into bubbles`, (await page.locator('.map-cluster').count()) > 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${label}-directory-map.png`, fullPage: false });
  await page.locator('.leaflet-marker-icon[title*="Yucateca"]').click();
  check(`[${label}] pin popup opens`, await page.locator('.leaflet-popup').isVisible().catch(() => false));

  // Filter by specialty
  if (mobile) await page.getByRole('tab', { name: 'Lista' }).click();
  await page.getByRole('button', { name: /^Restaurante \d+/ }).click();
  await page.waitForTimeout(500);
  const rest = Number((await page.getByText(/\d+ negocios?/).first().textContent()).match(/\d+/)[0]);
  check(`[${label}] filter by specialty`, rest > 0 && rest < total && page.url().includes('tipo=restaurant'), `${rest}/${total}`);
  await showMap();
  await page.waitForTimeout(500);
  check(`[${label}] map pins follow the filter`, (await pinTotal(page)) === rest);
  await page.locator('.map-cluster').first().click().catch(() => {});
  await page.waitForTimeout(800);

  // Filter by zone (state + city)
  await page.goto(`${BASE}/directorio?estado=Jalisco`);
  await page.getByText(/\d+ negocios?/).first().waitFor({ timeout: 15000 });
  const jal = Number((await page.getByText(/\d+ negocios?/).first().textContent()).match(/\d+/)[0]);
  check(`[${label}] filter by zone`, jal > 0 && jal < total, `${jal}/${total}`);
  check(`[${label}] city select enabled after state`, await page.getByLabel('Ciudad').isEnabled());

  // Restaurant reservation from the public page
  await page.goto(`${BASE}/b/restaurante-demo`);
  await page.getByText('Reserva tu mesa', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '4', exact: true }).click();
  const dates = page.locator('section:has(h2:has-text("Elige el día")) button');
  let picked = false;
  for (let i = 4; i < 10 && !picked; i++) {
    await dates.nth(i).click();
    await page.waitForTimeout(800);
    const times = page.locator('section:has(h2:has-text("Elige la hora")) .grid button');
    if ((await times.count()) > 2) {
      await times.nth(2).click();
      picked = true;
    }
  }
  check(`[${label}] restaurant slots for 4 people`, picked);
  await page.getByPlaceholder('Nombre', { exact: true }).fill(`Mesa UI ${label}`);
  await page.getByPlaceholder('WhatsApp').fill('5512340000');
  await page.screenshot({ path: `${out}/${label}-restaurant-booking.png`, fullPage: true });
  await page.getByRole('button', { name: 'Confirmar reservación' }).click();
  await page.getByText('Tu mesa está reservada').waitFor({ timeout: 15000 }).catch(() => {});
  check(`[${label}] guest reserves a table`, await page.getByText('Tu mesa está reservada').isVisible());
  check(`[${label}] confirmation mentions party size`, await page.getByText(/Mesa para 4 personas/).isVisible());

  // Restaurant back office
  await page.goto(`${BASE}/login`);
  await page.fill('#email', 'restaurante@agenda.mx');
  await page.fill('#password', 'demo1234');
  await page.click('button[type=submit], form button');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  await page.goto(`${BASE}/agenda`);
  await page.getByRole('heading', { name: 'Reservaciones' }).waitFor({ timeout: 15000 }).catch(() => {});
  check(`[${label}] restaurant agenda is "Reservaciones"`, await page.getByRole('heading', { name: 'Reservaciones' }).isVisible());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/${label}-restaurant-agenda.png`, fullPage: true });
  await page.goto(`${BASE}/tables`);
  await page.getByText('Mesa 8').waitFor({ timeout: 15000 }).catch(() => {});
  check(`[${label}] tables page`, await page.getByText('Mesa 8').isVisible());
  await page.screenshot({ path: `${out}/${label}-tables.png`, fullPage: true });
  await page.goto(`${BASE}/settings`);
  await page.locator('#perfil .leaflet-marker-icon').waitFor({ timeout: 15000 }).catch(() => {});
  check(`[${label}] settings shows profile map pin`, (await page.locator('#perfil .leaflet-marker-icon').count()) === 1);
  await ctx.close();
}

await run({ width: 1366, height: 900 }, 'desktop');
await run({ width: 390, height: 844 }, 'mobile');
async function newKinds(viewport, label) {
  const open = async () => {
    const ctx = await browser.newContext({ viewport, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/tile\.openstreetmap/.test(m.text()) && errors.push(`${label} console: ${m.text()}`));
    return { ctx, page };
  };
  const section = (page, title) => page.locator(`section:has(h2:has-text("${title}"))`);
  const pickDayAndTime = async (page, timeTitle) => {
    const days = section(page, 'Elige el día').locator('button');
    for (let i = 4; i < 12; i++) {
      await days.nth(i).click();
      await page.waitForTimeout(900);
      const times = section(page, timeTitle).locator('.grid button');
      if ((await times.count()) > 2) {
        await times.nth(1).click();
        return true;
      }
    }
    return false;
  };
  const fill = async (page, name, phone) => {
    await page.getByPlaceholder('Nombre', { exact: true }).fill(name);
    await page.getByPlaceholder('WhatsApp').fill(phone);
  };
  const backOffice = async (page, email) => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', email);
    await page.fill('#password', 'demo1234');
    await page.click('button[type=submit], form button');
    await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  };

  // Barbershop: choose a barber
  {
    const { ctx, page } = await open();
    await page.goto(`${BASE}/b/barberia-demo`);
    await section(page, 'Elige un servicio').locator('button').first().click();
    const chips = section(page, '¿Con quién?').locator('button');
    await chips.first().waitFor({ timeout: 15000 });
    check(`[${label}] barbershop offers "any" + 3 barbers`, (await chips.count()) === 4);
    const barber = (await chips.nth(2).innerText()).trim();
    await chips.nth(2).click();
    check(`[${label}] barber slots`, await pickDayAndTime(page, 'Elige la hora'));
    await fill(page, `Barbería UI ${label}`, '551515000' + (label === 'mobile' ? '2' : '1'));
    await page.screenshot({ path: `${out}/${label}-barber-booking.png`, fullPage: true });
    await page.getByRole('button', { name: 'Confirmar cita' }).click();
    await page.getByText('Tu cita está agendada').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] booked with the chosen barber`, await page.getByText(`con ${barber}`).first().isVisible().catch(() => false), barber);
    await backOffice(page, 'barberia@agenda.mx');
    await page.goto(`${BASE}/team`);
    await page.getByRole('heading', { name: 'Equipo' }).waitFor({ timeout: 15000 }).catch(() => {});
    await page.getByText(barber, { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] team page lists barbers`, await page.getByText(barber, { exact: true }).first().isVisible().catch(() => false));
    await page.screenshot({ path: `${out}/${label}-team.png`, fullPage: true });
    await page.goto(`${BASE}/agenda`);
    await page.getByRole('button', { name: 'Todos' }).first().waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] agenda filter by barber`, await page.getByRole('button', { name: 'Todos' }).first().isVisible().catch(() => false));
    await page.screenshot({ path: `${out}/${label}-barber-agenda.png`, fullPage: true });
    await ctx.close();
  }

  // Yoga studio: book a spot in class
  {
    const { ctx, page } = await open();
    await page.goto(`${BASE}/b/yoga-demo`);
    await section(page, 'Elige la clase').waitFor({ timeout: 15000 });
    const days = section(page, 'Elige el día').locator('button');
    await days.nth(Math.min(3, (await days.count()) - 1)).click();
    const cls = section(page, 'Elige la clase').locator('button:not([disabled])').first();
    await cls.waitFor({ timeout: 10000 }).catch(() => {});
    check(`[${label}] class list shows spots left`, /lugar/.test(await cls.innerText().catch(() => '')));
    await cls.click();
    await fill(page, `Yoga UI ${label}`, '551616000' + (label === 'mobile' ? '2' : '1'));
    await page.screenshot({ path: `${out}/${label}-class-booking.png`, fullPage: true });
    await page.getByRole('button', { name: 'Reservar lugar' }).click();
    await page.getByText('Tu lugar está reservado').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] guest books a class spot`, await page.getByText('Tu lugar está reservado').isVisible());
    await backOffice(page, 'clases@agenda.mx');
    await page.goto(`${BASE}/classes`);
    await page.getByRole('heading', { name: 'Clases' }).waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] studio classes page`, await page.getByRole('heading', { name: 'Clases' }).isVisible().catch(() => false));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${out}/${label}-classes.png`, fullPage: true });
    await ctx.close();
  }

  // Padel club: rent a court for 90 minutes
  {
    const { ctx, page } = await open();
    await page.goto(`${BASE}/b/padel-demo`);
    await section(page, 'Elige el espacio').waitFor({ timeout: 15000 });
    check(`[${label}] courts listed with price per hour`, (await section(page, 'Elige el espacio').getByText('/ hora').count()) >= 4);
    await section(page, '¿Cuánto tiempo?').locator('button').nth(1).click();
    check(`[${label}] court start times`, await pickDayAndTime(page, 'Hora de inicio'));
    await fill(page, `Pádel UI ${label}`, '551717000' + (label === 'mobile' ? '2' : '1'));
    await page.screenshot({ path: `${out}/${label}-rental-booking.png`, fullPage: true });
    await page.getByRole('button', { name: 'Confirmar renta' }).click();
    await page.getByText('Tu espacio está reservado').waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] guest rents a court`, await page.getByText('Tu espacio está reservado').isVisible());
    await backOffice(page, 'padel@agenda.mx');
    await page.goto(`${BASE}/spaces`);
    await page.getByRole('heading', { name: 'Espacios' }).waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] club spaces page`, await page.getByRole('heading', { name: 'Espacios' }).isVisible().catch(() => false));
    await page.goto(`${BASE}/agenda`);
    await page.getByRole('heading', { name: 'Reservas' }).waitFor({ timeout: 15000 }).catch(() => {});
    check(`[${label}] club agenda is "Reservas"`, await page.getByRole('heading', { name: 'Reservas' }).isVisible().catch(() => false));
    await page.screenshot({ path: `${out}/${label}-padel-agenda.png`, fullPage: true });
    await ctx.close();
  }
}

await publicPages({ width: 1366, height: 900 }, 'desktop');
await publicPages({ width: 390, height: 844 }, 'mobile');
await newKinds({ width: 1366, height: 900 }, 'desktop');
await newKinds({ width: 390, height: 844 }, 'mobile');
await browser.close();
check('no JS errors in browser', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(results.join('\n'));
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
