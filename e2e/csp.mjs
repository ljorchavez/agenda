/**
 * The production build with the production security headers (CSP etc., `vite preview` reads
 * apps/web/security-headers.json): main screens must load with no CSP violation.
 * Needs the API on :3000 and `pnpm --filter @agenda/web exec vite preview --port 4173`.
 */
import { chromium } from 'playwright';
const B = process.env.BASE ?? 'http://localhost:4173';
const out = [];
const ok = (name, cond, info = '') => out.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : info}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, locale: 'es-MX' });
const violations = [];
page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(m.text())) violations.push(m.text()); });
page.on('pageerror', (e) => { if (!/_leaflet_pos/.test(e.message)) violations.push(`pageerror: ${e.message}`); });

const res = await page.goto(`${B}/`);
ok('CSP header is sent', /default-src 'self'/.test(res.headers()['content-security-policy'] ?? ''));
ok('frames are denied', res.headers()['x-frame-options'] === 'DENY');
await page.goto(`${B}/?login=1`);
await page.fill('#email', 'demo@lugali.com');
await page.fill('#password', 'demo1234');
await page.locator('form .btn-primary').first().click();
await page.waitForURL(/\/agenda/, { timeout: 15000 });
for (const path of ['/agenda', '/customers', '/payments', '/pos', '/reports', '/settings', '/settings?tab=plan', '/settings?tab=account']) {
  await page.goto(`${B}${path}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
}
await page.goto(`${B}/settings?tab=account`);
await page.getByTestId('two-factor').waitFor({ timeout: 8000 }).catch(() => {});
ok('two-step sign-in section shows in settings', (await page.getByTestId('two-factor').count()) > 0);
await page.goto(`${B}/settings?tab=plan`);
await page.getByTestId('business-data').waitFor({ timeout: 8000 }).catch(() => {});
ok('owner sees export/delete', (await page.getByTestId('export-data').count()) === 1);
await page.goto(`${B}/b/barberia-demo`);
await page.waitForLoadState('networkidle').catch(() => {});
await page.goto(`${B}/`);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1500);
ok('no CSP violations on the main screens', violations.length === 0, violations.slice(0, 5).join(' | '));
await browser.close();
console.log(out.join('\n'));
