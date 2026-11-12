import { Captcha } from './Captcha';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { PublicBusinessDto, PublicOfferingDto, PurchaseStatusDto } from '@agenda/shared';
import { api } from '../lib/api';
import { dateOnly, money } from '../lib/format';
import { ErrorText, Loading, Modal } from './ui';

type Item = { kind: 'plan'; offering: PublicOfferingDto } | { kind: 'gift_card'; amountCents: number };

const offeringLine = (t: (k: string, o?: Record<string, unknown>) => string, o: PublicOfferingDto) =>
  [
    o.kind === 'membership'
      ? o.sessions == null ? t('sales.unlimited') : t('sales.perMonth', { count: o.sessions })
      : t('sales.sessions', { count: o.sessions ?? 0 }),
    o.validityDays ? t('sales.validDays', { count: o.validityDays }) : null,
    o.serviceNames.length ? o.serviceNames.join(', ') : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** Booking page: packages, memberships and gift cards to buy online (business's Mercado Pago). */
export function ShopSection({ business }: { business: PublicBusinessDto }) {
  const { t } = useTranslation();
  const [item, setItem] = useState<Item | null>(null);
  const shop = business.shop;
  if (!shop) return null;
  return (
    <section className="card mt-4 space-y-3" data-testid="shop">
      <h2 className="font-semibold">🛒 {t('shop.title')}</h2>
      {shop.offerings.length > 0 && (
        <ul className="space-y-2">
          {shop.offerings.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{o.name}</div>
                <div className="text-xs text-slate-500">{offeringLine(t, o)}</div>
              </div>
              <button type="button" className="btn-primary shrink-0 !py-1.5" onClick={() => setItem({ kind: 'plan', offering: o })}>
                {money(o.priceCents)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {shop.giftCardAmounts.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="font-medium">🎁 {t('shop.giftCard')}</div>
          <p className="text-xs text-slate-500">{t('shop.giftCardHelp')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {shop.giftCardAmounts.map((a) => (
              <button key={a} type="button" className="btn-secondary !py-1.5" onClick={() => setItem({ kind: 'gift_card', amountCents: a })}>
                {money(a)}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500">🔒 {t('shop.paidWithMp')}</p>
      {item && <BuyModal slug={business.slug} item={item} onClose={() => setItem(null)} />}
    </section>
  );
}

function BuyModal({ slug, item, onClose }: { slug: string; item: Item; onClose: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', phone: '', email: '', recipientName: '' });
  const buy = useMutation({
    mutationFn: () =>
      api<{ checkoutUrl: string | null; purchasePath: string }>(`/public/${slug}/purchases`, {
        method: 'POST',
        body: {
          ...(item.kind === 'plan' ? { kind: 'plan', offeringId: item.offering.id } : { kind: 'gift_card', amountCents: item.amountCents, recipientName: form.recipientName || null }),
          name: form.name,
          phone: form.phone,
          email: form.email || undefined,
        },
      }),
    onSuccess: (r) => window.location.assign(r.checkoutUrl ?? r.purchasePath),
  });
  const title = item.kind === 'plan' ? item.offering.name : t('shop.giftCard');
  const price = item.kind === 'plan' ? item.offering.priceCents : item.amountCents;
  return (
    <Modal open title={`${title} · ${money(price)}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); buy.mutate(); }} data-testid="buy-form">
        <Captcha />
        {item.kind === 'gift_card' && (
          <input className="input" maxLength={120} placeholder={t('shop.recipient')} value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} />
        )}
        <input required minLength={2} className="input" placeholder={t('customers.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input required type="tel" className="input" placeholder={t('customers.phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input type="email" className="input" placeholder={`${t('customers.email')} (${t('common.optional')})`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <ErrorText error={buy.error} ns="shop" />
        <button className="btn-primary w-full" disabled={buy.isPending}>{buy.isPending ? t('common.loading') : t('shop.payMp', { amount: money(price) })}</button>
        <p className="text-center text-xs text-slate-500">{t('shop.afterPay')}</p>
      </form>
    </Modal>
  );
}

/** /compra/:token — after paying: waits for Mercado Pago and shows the gift card code or the package. */
export function PurchasePage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const [tries, setTries] = useState(0);
  const q = useQuery({
    queryKey: ['purchase', token],
    queryFn: () => api<PurchaseStatusDto>(`/public/purchases/${token}`),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'pending' && tries < 40 ? 4000 : false),
  });
  useEffect(() => {
    if (q.data?.status === 'pending') setTries((n) => n + 1);
  }, [q.dataUpdatedAt, q.data?.status]);
  const d = q.data;
  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-10">
      <div className="card mx-auto max-w-md space-y-4 text-center" data-testid="purchase-page">
        {q.isLoading ? <Loading /> : !d ? (
          <p className="text-slate-600">{t('shop.badLink')}</p>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-semibold">{d.businessName}</h1>
              <p className="text-sm text-slate-500">{d.itemName} · {money(d.amountCents)}</p>
            </div>
            {d.status === 'paid' && (d.giftCardCode || d.plan) ? (
              d.giftCardCode ? (
                <div className="space-y-2">
                  <p className="text-lg">🎁 {t('shop.giftReady')}</p>
                  {d.recipientName && <p className="text-sm text-slate-600">{t('shop.forRecipient', { name: d.recipientName })}</p>}
                  <p className="rounded-xl border-2 border-dashed border-brand-600 bg-brand-50 py-3 font-mono text-2xl font-bold tracking-widest" data-testid="gift-code">{d.giftCardCode}</p>
                  <p className="text-xs text-slate-500">{t('shop.giftUse')}</p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-lg">✅ {t('shop.planReady')}</p>
                  <p className="text-sm text-slate-600">
                    {d.plan!.sessionsLeft == null ? t('sales.unlimited') : t('sales.sessions', { count: d.plan!.sessionsLeft })}
                    {d.plan!.expiresOn && ` · ${t('sales.until', { date: dateOnly(d.plan!.expiresOn) })}`}
                  </p>
                  <p className="text-xs text-slate-500">{t('shop.planUse')}</p>
                </div>
              )
            ) : d.status === 'pending' || d.status === 'paid' ? (
              <p className="text-slate-600">⏳ {t('shop.waiting')}</p>
            ) : (
              <p className="text-rose-700">{t('shop.failed')}</p>
            )}
            <Link to={`/b/${d.slug}`} className="btn-primary inline-block">{t('shop.book')}</Link>
            <p className="text-xs text-slate-500">{t('shop.saveLink')}</p>
          </>
        )}
      </div>
    </div>
  );
}
