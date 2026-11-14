/**
 * Layout audit: opens every screen of the app (computer and phone sizes) and measures what the
 * eye catches — the page sliding sideways, scrollbars inside boxes, cards side by side with
 * different tops or heights, controls in one row with different heights, and the same kind of
 * element styled differently (tables, tab bars, page titles). Prints a report; never fails.
 * Needs the API on :3000 and the web on :5173 with the demo data: node e2e/ui-audit.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const SIZES = [
  { name: 'pc', width: 1366, height: 768 },
  { name: 'phone', width: 390, height: 844 },
];
const PAGES = [
  '/agenda',
  '/customers',
  'CUSTOMER',
  '/services',
  '/resources',
  '/payments',
  '/payments?tab=movements',
  '/payments?tab=commissions',
  '/payments?tab=cash',
  '/payments?tab=reports',
  '/pos',
  '/pos?tab=sales',
  '/pos?tab=products',
  '/pos?tab=cash',
  '/pos?tab=reports',
  '/reports',
  ...['business', 'booking', 'payments', 'invoicing', 'promos', 'packages', 'forms', 'reviews', 'locations', 'users', 'plan', 'account'].map((t) => `/settings?tab=${t}`),
];

/** Runs in the page: what looks off. */
function measure() {
  const out = [];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const label = (el) => {
    const id = el.getAttribute('data-testid');
    const role = el.getAttribute('role');
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 6).join('.');
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${role ? `(${role})` : ''}.${cls} "${txt}"`;
  };
  // 1. The whole page slides sideways
  const sw = document.documentElement.scrollWidth;
  if (sw > innerWidth + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('[class*="overflow-x-auto"],[class*="overflow-auto"]'));
    out.push(`PAGE-OVERFLOW ${sw}>${innerWidth}: ${wide.slice(-3).map(label).join(' | ')}`);
  }
  // 2. Boxes with their own scrollbar
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
    const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
    if (y || x) out.push(`SCROLL-${y ? 'Y' : ''}${x ? 'X' : ''} ${el.clientWidth}x${el.clientHeight} content ${el.scrollWidth}x${el.scrollHeight}: ${label(el)}`);
  }
  // 3. Grids: cards in the same row with different tops or heights
  for (const g of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(g);
    if (cs.display !== 'grid' || !vis(g)) continue;
    const kids = [...g.children].filter(vis).map((k) => ({ k, r: k.getBoundingClientRect() }));
    const rows = new Map();
    for (const x of kids) {
      const key = [...rows.keys()].find((t) => Math.abs(t - x.r.top) < 30) ?? x.r.top;
      rows.set(key, [...(rows.get(key) ?? []), x]);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      const cards = row.filter((x) => /card|border/.test(String(x.k.className)));
      if (cards.length < 2) continue;
      const tops = cards.map((x) => Math.round(x.r.top));
      const hs = cards.map((x) => Math.round(x.r.height));
      if (Math.max(...tops) - Math.min(...tops) > 2) out.push(`GRID-TOPS ${tops.join('/')}: ${cards.map((x) => label(x.k)).join(' || ')}`);
      else if (Math.max(...hs) - Math.min(...hs) > 4 && cs.alignItems !== 'start') out.push(`GRID-HEIGHTS ${hs.join('/')}: ${cards.map((x) => label(x.k)).join(' || ')}`);
    }
  }
  // 4. One row of controls with different heights (filters, toolbars)
  for (const f of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(f);
    if (!/flex/.test(cs.display) || cs.flexDirection.startsWith('column') || !vis(f)) continue;
    const ctrls = [...f.children].filter((k) => vis(k) && /^(INPUT|SELECT|BUTTON)$/.test(k.tagName) && !['checkbox', 'radio'].includes(k.type));
    if (ctrls.length < 2) continue;
    const byTop = new Map();
    for (const c of ctrls) {
      const r = c.getBoundingClientRect();
      const key = [...byTop.keys()].find((t) => Math.abs(t - (r.top + r.height / 2)) < 12) ?? r.top + r.height / 2;
      byTop.set(key, [...(byTop.get(key) ?? []), { c, h: Math.round(r.height) }]);
    }
    for (const row of byTop.values()) {
      if (row.length < 2) continue;
      const hs = row.map((x) => x.h);
      if (Math.max(...hs) - Math.min(...hs) > 3) out.push(`ROW-HEIGHTS ${hs.join('/')}: ${row.map((x) => label(x.c)).join(' || ')}`);
    }
  }
  // 5. Same kind of element, different look
  const sig = (el) => {
    const cs = getComputedStyle(el);
    return `${cs.borderTopWidth} ${cs.borderTopColor} r${cs.borderTopLeftRadius} bg${cs.backgroundColor} pad${cs.paddingTop}`;
  };
  const tables = [...document.querySelectorAll('table')].filter(vis).map((t) => `table: wrap(${sig(t.parentElement)}) th(${t.querySelector('th') ? getComputedStyle(t.querySelector('th')).fontSize + ' ' + getComputedStyle(t.querySelector('th')).textTransform + ' ' + getComputedStyle(t.querySelector('th')).color + ' bg' + getComputedStyle(t.querySelector('thead') ?? t).backgroundColor : '-'})`);
  const tabs = [...document.querySelectorAll('[role=tablist]')].filter(vis).map((t) => `tablist: ${sig(t)} h${Math.round(t.getBoundingClientRect().height)}`);
  const h1 = [...document.querySelectorAll('h1')].filter(vis).map((h) => `h1: ${getComputedStyle(h).fontSize} ${getComputedStyle(h).fontWeight} top${Math.round(h.getBoundingClientRect().top)}`);
  const inputs = [...document.querySelectorAll('main input:not([type=checkbox]):not([type=radio]), main select')].filter(vis).map((i) => `ctl:${Math.round(i.getBoundingClientRect().height)}`);
  return { issues: out, style: [...new Set([...tables, ...tabs, ...h1])], heights: [...new Set(inputs)].join(',') };
}

const browser = await chromium.launch();
const report = [];
const styles = new Map();
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'es-MX' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/?login=1');
  await page.fill('#email', 'demo@lugali.com');
  await page.fill('#password', 'demo1234');
  await page.locator('form .btn-primary').first().click();
  await page.waitForURL(/\/agenda/, { timeout: 20000 });
  for (let path of PAGES) {
    if (path === 'CUSTOMER') {
      await page.goto(BASE + '/customers');
      const href = await page.locator('a[href^="/customers/"]').first().getAttribute('href').catch(() => null);
      if (!href) continue;
      path = href;
    }
    await page.goto(BASE + path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
    const m = await page.evaluate(measure);
    const shown = path.startsWith('/customers/') ? '/customers/:id' : path;
    for (const i of [...new Set(m.issues)]) report.push(`${size.name} ${shown} ${i}`);
    for (const s of m.style) styles.set(s, [...(styles.get(s) ?? []), `${size.name}${shown}`]);
    report.push(`${size.name} ${shown} CONTROL-HEIGHTS ${m.heights}`);
  }
  await ctx.close();
}
await browser.close();
console.log(report.join('\n'));
console.log('--- STYLES (same kind of element should look the same) ---');
for (const [s, where] of styles) console.log(`${s}  <- ${where.slice(0, 6).join(' ')}${where.length > 6 ? ` +${where.length - 6}` : ''}`);
