/**
 * Real Stripe (test mode) walk-through of Lugali's own billing, with the test card 4242.
 * Needs the API on :3000 (STRIPE_SECRET_KEY = a sk_test_ key, APP_URL=http://localhost:5173)
 * and the web on :5173. Writes screenshots, videos and report.txt to OUT (default /tmp/stripe).
 *   node e2e/stripe.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '/tmp/stripe';
mkdirSync(`${OUT}/video`, { recursive: true });
const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY?.startsWith('sk_test_')) throw new Error('A Stripe test key is required');
const API = 'http://localhost:3000/api';
const WEB = 'http://localhost:5173';
const api = async (p, body, tok, method) => {
  const r = await fetch(API + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const stripe = async (p) => (await fetch('https://api.stripe.com/v1' + p, { headers: { authorization: `Bearer ${KEY}` } })).json();
const pesos = (c) => `$${(c / 100).toFixed(2)}`;
const iva = (c) => Math.round(c * 1.16);

const report = [];
const log = (s) => { report.push(s); console.log(s); };
const ok = (name, cond, info = '') => log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);

const browser = await chromium.launch();
const run = Date.now().toString(36);
let shot = 0;

/** Pays a Checkout session in the browser as the owner of `token`, and lands back on Lugali. */
async function payInBrowser(label, token, checkoutUrl) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'es-MX', recordVideo: { dir: `${OUT}/video`, size: { width: 1100, height: 900 } } });
  await ctx.addCookies([{ name: 'lugali_session', value: token, url: WEB }]);
  const page = await ctx.newPage();
  await page.goto(WEB + '/');
  await page.evaluate(() => localStorage.setItem('agenda.session', '1'));
  await page.goto(checkoutUrl);
  const card = page.locator('#cardNumber');
  for (let attempt = 0; attempt < 4 && !(await card.isVisible()); attempt++) {
    await page.waitForTimeout(5000);
    if (await card.isVisible()) break;
    // Some Checkout layouts list payment methods first: open "Tarjeta"
    for (const sel of ['[data-testid="card-accordion-item-button"]', '#payment-method-accordion-item-title-card', 'button:has-text("Tarjeta")', 'label:has-text("Tarjeta")']) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => undefined);
        break;
      }
    }
  }
  await card.waitFor({ timeout: 30_000 }).catch(async (e) => {
    await page.screenshot({ path: `${OUT}/fail-${label}.png` });
    log(`      Página: ${(await page.locator('body').innerText()).slice(0, 700).replace(/\n/g, ' | ')}`);
    throw e;
  });
  // Adaptive Pricing offers the visitor's currency (USD from this US test machine): pay in pesos
  const mxn = page.getByRole('button', { name: 'MXN', exact: true });
  if (await mxn.count()) {
    await mxn.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${label}-checkout.png`, fullPage: true });
  await page.fill('#cardNumber', '4242424242424242');
  await page.fill('#cardExpiry', '12 / 34');
  await page.fill('#cardCvc', '123');
  await page.fill('#billingName', 'Prueba Lugali');
  const country = page.locator('#billingCountry');
  if (await country.count()) await country.selectOption('MX').catch(() => undefined);
  const zip = page.locator('#billingPostalCode');
  if ((await zip.count()) && (await zip.isVisible())) await zip.fill('28000');
  await page.locator('.SubmitButton, button[type=submit]').first().click();
  await page.waitForURL(/localhost:5173\/settings/, { timeout: 90_000 });
  const paid = await page.locator('[data-testid=billing-paid]').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${label}-lugali.png`, fullPage: false });
  const banner = paid ? await page.locator('[data-testid=billing-paid]').innerText() : '';
  await ctx.close();
  return { paid, banner, url: page.url() };
}

async function shotPage(label, url) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, locale: 'es-MX' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => undefined);
  await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${label}.png`, fullPage: true });
  await ctx.close();
}

const register = async (n, businessName) => {
  const r = await api('/auth/register', { businessName, businessType: 'barbershop', name: `Dueño ${n}`, email: `stripe-${n}-${run}@test.mx`, password: 'password123', plan: 'free' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${n}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
};
const csOf = (url) => /(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];

/** Subscribes with the card and checks Stripe and Lugali agree. Returns the subscription. */
async function subscribe(label, token, plan, expectedCents) {
  const go = await api('/tenant/plan', { plan }, token, 'PUT');
  ok(`${label}: Lugali abre Stripe Checkout`, Boolean(go.body?.checkoutUrl), go.body?.checkoutUrl ? '' : JSON.stringify(go.body).slice(0, 200));
  const cs = csOf(go.body.checkoutUrl);
  const back = await payInBrowser(label, token, go.body.checkoutUrl);
  ok(`${label}: regresa a Lugali con confirmación`, back.paid, back.url);
  if (back.banner) log(`      Aviso: "${back.banner}"`);
  const session = await stripe(`/checkout/sessions/${cs}?expand[]=subscription.latest_invoice`);
  const sub = session.subscription;
  const inv = sub?.latest_invoice;
  ok(`${label}: es suscripción mensual en Stripe`, session.mode === 'subscription' && sub?.status === 'active' && sub?.items?.data?.[0]?.price?.recurring?.interval === 'month', `${session.mode} ${sub?.status}`);
  ok(`${label}: cobro correcto ${pesos(expectedCents)} MXN`, inv?.amount_paid === expectedCents && inv?.currency === 'mxn' && inv?.status === 'paid', `pagado ${pesos(inv?.amount_paid ?? 0)} ${inv?.currency} ${inv?.status}`);
  const info = (await api('/tenant/plan', undefined, token)).body;
  ok(`${label}: Lugali activa el plan`, info.plan === plan && info.billing.status === 'active' && info.billing.amountCents === expectedCents, `${info.plan} ${info.billing.status} ${info.billing.amountCents}`);
  log(`      Recibo: ${inv?.number ?? ''} · ${inv?.customer_email ?? ''}`);
  if (inv?.hosted_invoice_url) await shotPage(`${label}-recibo`, inv.hosted_invoice_url);
  return { sub, cs };
}

/** Changes plan from Settings like the owner would: pick, read the confirmation, confirm. */
async function changeInUi(label, token, plan, { cancelFirst = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'es-MX', recordVideo: { dir: `${OUT}/video`, size: { width: 1100, height: 900 } } });
  await ctx.addCookies([{ name: 'lugali_session', value: token, url: WEB }]);
  const page = await ctx.newPage();
  await page.goto(WEB + '/');
  await page.evaluate(() => localStorage.setItem('agenda.session', '1'));
  await page.goto(WEB + '/settings?tab=plan');
  await page.getByRole('button', { name: 'Cambiar plan' }).click();
  const pick = () => page.getByTestId(`plan-${plan}`).getByRole('button').click();
  await pick();
  const dialog = page.getByTestId('confirm-plan');
  const shown = await dialog.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const text = shown ? (await dialog.innerText()).replace(/\n+/g, ' / ') : '';
  await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${label}-confirmar.png` });
  let cancelledOk = true;
  if (cancelFirst && shown) {
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    const before = (await api('/tenant/plan', undefined, token)).body.plan;
    cancelledOk = (await dialog.count()) === 0 && before !== plan;
    await pick();
    await dialog.waitFor({ timeout: 10_000 });
  }
  if (shown) {
    await page.getByTestId('confirm-plan-yes').click();
    // Stripe updates the subscription and charges the difference before the dialog closes
    await dialog.waitFor({ state: 'detached', timeout: 45_000 }).catch(() => undefined);
  }
  await ctx.close();
  return { shown, text, cancelledOk };
}

const invoicesOf = async (subId) => (await stripe(`/invoices?subscription=${subId}&limit=10`)).data ?? [];

try {
  // 1. New subscription on each plan
  log('== 1. Suscripción nueva en cada plan ==');
  const accounts = {};
  for (const [plan, cents] of [['individual', 24_900], ['standard', 39_900], ['premium', 79_900]]) {
    const token = await register(plan, `Prueba ${plan} ${run}`);
    accounts[plan] = { token, ...(await subscribe(`plan-${plan}`, token, plan, iva(cents))) };
  }

  // 2. Plan change: same subscription, prorated charge
  log('== 2. Cambio de plan ==');
  {
    const { token, sub } = accounts.individual;
    const ui = await changeInUi('cambio-plan', token, 'standard', { cancelFirst: true });
    ok('Pide confirmación antes de cambiar de plan', ui.shown, ui.text);
    log(`      Confirmación: "${ui.text}"`);
    ok('Si cancela, no cambia nada', ui.cancelledOk);
    const upInfo = (await api('/tenant/plan', undefined, token)).body;
    ok('Individual → Estándar sin volver a pagar en Checkout', upInfo.plan === 'standard' && upInfo.billing.status === 'active', upInfo.plan);
    await new Promise((r) => setTimeout(r, 2500));
    const s = await stripe(`/subscriptions/${sub.id}`);
    ok('Misma suscripción, nuevo precio', s.id === sub.id && s.status === 'active' && s.items.data[0].price.unit_amount === iva(39_900), `${s.items.data[0].price.unit_amount}`);
    const inv = (await invoicesOf(sub.id))[0];
    log(`      Factura de prorrateo: ${pesos(inv.amount_due)} (${inv.status}) · líneas: ${inv.lines.data.map((l) => `${l.description} ${pesos(l.amount)}`).join(' | ')}`);
    ok('Cobra la diferencia prorrateada (≤ $174.00)', inv.amount_due > 0 && inv.amount_due <= iva(39_900) - iva(24_900) + 1 && inv.status === 'paid', pesos(inv.amount_due));
    if (inv.hosted_invoice_url) await shotPage('cambio-plan-recibo', inv.hosted_invoice_url);

    await changeInUi('bajar-plan', token, 'individual');
    const down = (await api('/tenant/plan', undefined, token)).body;
    ok('Estándar → Individual (bajar)', down.plan === 'individual', down.plan);
    await new Promise((r) => setTimeout(r, 2500));
    const inv2 = (await invoicesOf(sub.id))[0];
    const cust = await stripe(`/customers/${sub.customer}`);
    log(`      Al bajar: factura ${pesos(inv2.total)} · saldo a favor del cliente ${pesos(-cust.balance)}`);
    ok('Al bajar no cobra, deja saldo a favor', inv2.amount_due === 0 && cust.balance < 0, `${inv2.amount_due} ${cust.balance}`);
  }

  // 3. Extra location on Estándar (1 included) and Premium (2 included)
  log('== 3. Sucursal adicional ==');
  for (const plan of ['standard', 'premium']) {
    const { token, sub } = accounts[plan];
    const included = plan === 'premium' ? 2 : 1;
    for (let i = 2; i <= included + 1; i++) {
      const r = await api('/locations', { name: `Sucursal ${i}` }, token);
      if (r.status !== 201) ok(`${plan}: crear sucursal ${i}`, false, `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const s = await stripe(`/subscriptions/${sub.id}`);
    const loc = s.items.data.find((i) => (i.price.lookup_key ?? '').startsWith('lugali_extra_location_'));
    ok(`${plan}: la sucursal ${included + 1} se agrega a la suscripción`, loc?.quantity === 1 && loc.price.unit_amount === iva(19_900), JSON.stringify(s.items.data.map((i) => [i.price.lookup_key, i.quantity])));
    const inv = (await invoicesOf(sub.id))[0];
    log(`      Cobro prorrateado de la sucursal: ${pesos(inv.amount_paid)} (${inv.status})`);
    ok(`${plan}: cobra la sucursal prorrateada`, inv.status === 'paid' && inv.amount_paid > 0 && inv.amount_paid <= iva(19_900) + 1, pesos(inv.amount_paid));
    const info = (await api('/tenant/plan', undefined, token)).body;
    ok(`${plan}: Lugali muestra el nuevo total`, info.billing.amountCents === iva(plan === 'premium' ? 79_900 : 39_900) + iva(19_900), pesos(info.billing.amountCents));
  }

  // 4. Extra business: its own subscription at the add-on price, read-only until paid
  log('== 4. Negocio adicional ==');
  {
    const { token } = accounts.premium;
    const nb = await api('/businesses', { businessName: `Segundo negocio ${run}`, businessType: 'barbershop' }, token);
    ok('Se crea el negocio adicional', nb.status === 201, `${nb.status}`);
    const blocked = await api('/customers', { name: 'Antes de pagar' }, nb.body.token);
    ok('Queda en solo lectura hasta pagar', blocked.status === 402, `${blocked.status}`);
    await subscribe('negocio-adicional', nb.body.token, 'standard', iva(29_900));
    const after = await api('/customers', { name: 'Después de pagar' }, nb.body.token);
    ok('Después de pagar ya se puede usar', after.status === 201, `${after.status}`);
  }

  // 5. Downgrade to Gratis: subscription cancelled in Stripe
  log('== 5. Bajar a Gratis / cancelar ==');
  {
    const { token, sub } = accounts.standard;
    const r = await api('/tenant/plan', { plan: 'free' }, token, 'PUT');
    // Estándar now has 2 locations; Gratis allows 1, so Lugali refuses until one is closed
    ok('Con 2 sucursales Lugali pide cerrar una antes de bajar', r.status === 402, `${r.status} ${r.body?.error}`);
    const target = accounts.individual;
    const ui = await changeInUi('bajar-gratis', target.token, 'free');
    ok('Pide confirmación antes de bajar a Gratis', ui.shown, ui.text);
    log(`      Confirmación: "${ui.text}"`);
    const r2 = (await api('/tenant/plan', undefined, target.token)).body;
    ok('Bajar a Gratis', r2.plan === 'free', r2.plan);
    await new Promise((x) => setTimeout(x, 2500));
    const s = await stripe(`/subscriptions/${target.sub.id}`);
    ok('La suscripción queda cancelada en Stripe (sin más cobros)', s.status === 'canceled', s.status);
  }
} catch (e) {
  ok('script', false, e.stack ?? String(e));
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.txt`, report.join('\n') + '\n');
}
