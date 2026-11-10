/**
 * Screenshots of the main screens with the demo data, to review the UI.
 * Needs the API on :3000 and the web on :5173 (pnpm dev) and Playwright installed:
 *   npm i -D playwright && npx playwright install chromium
 *   OUT=/tmp/shots node e2e/screenshots.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const OUT = process.env.OUT ?? 'screenshots';
mkdirSync(OUT, { recursive: true });
const B = 'http://localhost:5173';
const api = async (path, body, token) => {
  const r = await fetch(`http://localhost:3000/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
let s = await api('/auth/login', { email: 'demo@agenda.mx', password: 'demo1234' });
const barber = s.businesses.find((b) => /Barber/i.test(b.name) && !/Güero/.test(b.name));
s = await api('/auth/switch', { tenantId: barber.id }, s.token);
const tok = s.token;
// A blocked afternoon and a rated booking with a note, so they show up
const res = await api('/resources', null, tok);
const mon = new Date(); mon.setHours(0,0,0,0);
const day = new Date(mon); day.setDate(day.getDate() + 1);
const at = (h) => { const d = new Date(day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
await api('/time-blocks', { resourceId: res[0].id, startsAt: at(14), endsAt: at(16), reason: 'Comida' }, tok);
const browser = await chromium.launch();
const shot = async (name, w, h, fn) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.addInitScript((t) => { localStorage.setItem('agenda.token', t); }, tok);
  await fn(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
};
await shot('1-semana', 1600, 950, async (p) => { await p.addInitScript(() => localStorage.setItem('agenda.view', 'week')); await p.goto(`${B}/agenda`); await p.waitForSelector('[data-testid=calendar-event]'); });
await shot('2-dia-por-persona', 1600, 950, async (p) => { await p.addInitScript(() => localStorage.setItem('agenda.view', 'day')); await p.goto(`${B}/agenda`); await p.waitForSelector('[data-testid=calendar-event]'); await p.getByRole('button', { name: /next|siguiente/i }).first().click(); await p.waitForTimeout(600); });
await shot('3-cita', 1600, 1100, async (p) => { await p.goto(`${B}/agenda`); await p.waitForSelector('[data-testid=calendar-event]'); await p.locator('[data-testid=calendar-event]').nth(3).click(); await p.waitForSelector('#am-notes'); await p.fill('#am-notes', 'Prefiere degradado bajo, sin navaja.'); await p.getByRole('radio', { name: /4/ }).click(); await p.waitForTimeout(500); });
await shot('4-bloquear', 1600, 950, async (p) => { await p.goto(`${B}/agenda`); await p.waitForSelector('[data-testid=calendar-event]'); await p.getByRole('button', { name: /Bloquear horario/ }).click(); await p.waitForSelector('#bl-target'); });
await shot('5-clientes', 1600, 900, async (p) => { await p.goto(`${B}/customers`); await p.waitForSelector('tbody tr'); });
await shot('6-equipo', 1600, 1150, async (p) => { await p.goto(`${B}/resources`); await p.waitForSelector('[data-testid=resource-card]'); await p.locator('[data-testid=resource-card]').first().click(); await p.getByLabel(/Horario propio/).check(); await p.getByRole('button', { name: /Agregar descanso/ }).click(); });
await shot('7-movil-agenda', 390, 844, async (p) => { await p.goto(`${B}/agenda`); await p.waitForSelector('[data-testid=calendar-event]'); });
await browser.close();
console.log('ok');
