import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_LIMITS, SALE_METHODS, type CustomerPlanDto, type GiftCardDto, type OfferingDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { dateOnly, money, toCents } from '../lib/format';
import { useServices } from '../lib/queries';
import { ErrorText, Modal } from './ui';

/** Does the current plan include packages/records/cash? Shows an upgrade note otherwise. */
export function useFeature(feature: 'packages' | 'records' | 'cash') {
  const { tenant } = useAuth();
  return PLAN_LIMITS[tenant?.plan ?? 'free'][feature];
}

export function UpgradeNote({ feature }: { feature: 'packages' | 'records' | 'cash' }) {
  const { t } = useTranslation();
  return (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid={`upgrade-${feature}`}>
      {t(`planFeatures.${feature}`)} <a href="/settings?tab=plan" className="font-medium underline">{t('planFeatures.see')}</a>
    </p>
  );
}

const sessionsText = (t: (k: string, o?: Record<string, unknown>) => string, sessions: number | null, kind: 'package' | 'membership') =>
  sessions == null ? t('sales.unlimited') : kind === 'membership' ? t('sales.perMonth', { count: sessions }) : t('sales.sessions', { count: sessions });

// ---------- Catalog (Configuración → Paquetes) ----------

type OfferingForm = { id?: string; kind: 'package' | 'membership'; name: string; price: string; sessions: string; validityDays: string; serviceIds: string[]; active: boolean };

export function OfferingsSection({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const enabled = useFeature('packages');
  const services = useServices();
  const list = useQuery({ queryKey: ['offerings'], queryFn: () => api<OfferingDto[]>('/offerings') });
  const [form, setForm] = useState<OfferingForm | null>(null);
  const save = useMutation({
    mutationFn: (f: OfferingForm) =>
      api(f.id ? `/offerings/${f.id}` : '/offerings', {
        method: f.id ? 'PUT' : 'POST',
        body: {
          kind: f.kind,
          name: f.name,
          priceCents: toCents(f.price || '0'),
          sessions: f.sessions ? Number(f.sessions) : null,
          validityDays: f.kind === 'package' ? Number(f.validityDays || 0) || null : null,
          serviceIds: f.serviceIds,
          active: f.active,
        },
      }),
    onSuccess: () => {
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['offerings'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/offerings/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['offerings'] }),
  });
  const svcName = (id: string) => services.data?.find((s) => s.id === id)?.name ?? '';
  return (
    <section className="card space-y-4" data-testid="offerings-section">
      <div>
        <h2 className="font-semibold">🎟️ {t('sales.catalogTitle')}</h2>
        <p className="text-sm text-slate-500">{t('sales.catalogHelp')}</p>
      </div>
      {!enabled && <UpgradeNote feature="packages" />}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {(list.data ?? []).map((o) => (
          <li key={o.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${o.active ? '' : 'opacity-50'}`}>
            <div>
              <div className="font-medium">{o.name} <span className="font-normal text-slate-500">· {money(o.priceCents)}</span></div>
              <div className="text-xs text-slate-500">
                {t(`sales.kind.${o.kind}`)} · {sessionsText(t, o.sessions, o.kind)}
                {o.validityDays ? ` · ${t('sales.validDays', { count: o.validityDays })}` : ''}
                {' · '}{o.serviceIds.length ? o.serviceIds.map(svcName).join(', ') : t('sales.allServices')}
                {o.activeCount > 0 && ` · ${t('sales.activeCount', { count: o.activeCount })}`}
              </div>
            </div>
            {!disabled && enabled && (
              <div className="flex gap-3 text-xs">
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setForm({ id: o.id, kind: o.kind, name: o.name, price: String(o.priceCents / 100), sessions: o.sessions ? String(o.sessions) : '', validityDays: o.validityDays ? String(o.validityDays) : '', serviceIds: o.serviceIds, active: o.active })}>{t('common.edit')}</button>
                <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('sales.deleteConfirm')) && remove.mutate(o.id)}>{t('common.delete')}</button>
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t('sales.emptyCatalog')}</li>}
      </ul>
      {form ? (
        <form className="space-y-3 rounded-lg border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="label" htmlFor="of-kind">{t('sales.type')}</label>
              <select id="of-kind" className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as OfferingForm['kind'] })}>
                <option value="package">{t('sales.kind.package')}</option>
                <option value="membership">{t('sales.kind.membership')}</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="of-name">{t('sales.name')}</label>
              <input id="of-name" required minLength={2} className="input" placeholder={form.kind === 'package' ? t('sales.namePackage') : t('sales.nameMembership')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="of-price">{t('sales.price')}</label>
              <input id="of-price" required type="number" min={0} step="0.01" className="input" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="of-sessions">{form.kind === 'package' ? t('sales.sessionsLabel') : t('sales.monthlyLimit')}</label>
              <input id="of-sessions" type="number" min={1} required={form.kind === 'package'} className="input" placeholder={form.kind === 'membership' ? t('sales.unlimited') : ''} value={form.sessions} onChange={(e) => setForm({ ...form, sessions: e.target.value })} />
            </div>
            {form.kind === 'package' && (
              <div>
                <label className="label" htmlFor="of-days">{t('sales.validity')}</label>
                <input id="of-days" type="number" min={1} required className="input" value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: e.target.value })} />
              </div>
            )}
          </div>
          <fieldset>
            <legend className="label">{t('sales.covers')}</legend>
            <div className="flex flex-wrap gap-2">
              {(services.data ?? []).filter((s) => s.active).map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs">
                  <input type="checkbox" checked={form.serviceIds.includes(s.id)} onChange={(e) => setForm({ ...form, serviceIds: e.target.checked ? [...form.serviceIds, s.id] : form.serviceIds.filter((x) => x !== s.id) })} />
                  {s.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">{t('sales.coversHelp')}</p>
          </fieldset>
          <ErrorText error={save.error} ns="sales" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={save.isPending}>{form.id ? t('common.done') : t('common.add')}</button>
          </div>
        </form>
      ) : (
        !disabled && enabled && (
          <button type="button" className="btn-secondary" onClick={() => setForm({ kind: 'package', name: '', price: '', sessions: '10', validityDays: '90', serviceIds: [], active: true })}>
            + {t('sales.newOffering')}
          </button>
        )
      )}
    </section>
  );
}

export function GiftCardsList() {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ['gift-cards'], queryFn: () => api<GiftCardDto[]>('/gift-cards') });
  return (
    <section className="card space-y-3" data-testid="gift-cards-section">
      <div>
        <h2 className="font-semibold">🎁 {t('sales.giftCards')}</h2>
        <p className="text-sm text-slate-500">{t('sales.giftCardsHelp')}</p>
      </div>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {(list.data ?? []).map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <div>
              <span className="font-mono font-semibold">{g.code}</span>
              <span className="ml-2 text-xs text-slate-500">{g.recipientName ?? g.customerName}{g.expiresOn ? ` · ${t('sales.until', { date: dateOnly(g.expiresOn) })}` : ''}</span>
            </div>
            <span className={g.balanceCents > 0 ? 'font-medium' : 'text-slate-400'}>{money(g.balanceCents)} / {money(g.initialCents)}</span>
          </li>
        ))}
        {list.data?.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t('sales.noGiftCards')}</li>}
      </ul>
    </section>
  );
}

// ---------- Customer detail ----------

export function CustomerPlansSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { scoped, manager } = useAccess();
  const enabled = useFeature('packages');
  const data = useQuery({
    queryKey: ['customer-plans', customerId],
    queryFn: () => api<{ plans: CustomerPlanDto[]; giftCards: GiftCardDto[] }>(`/customers/${customerId}/plans`),
  });
  const [selling, setSelling] = useState<null | 'plan' | 'gift'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/customer-plans/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customer-plans', customerId] }),
  });
  const plans = data.data?.plans ?? [];
  const cards = data.data?.giftCards ?? [];
  if (!enabled && !plans.length && !cards.length) return null;
  return (
    <section className="card space-y-3" data-testid="customer-plans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🎟️ {t('sales.customerTitle')}</h2>
        {enabled && !scoped && (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setSelling('plan')}>+ {t('sales.sellPlan')}</button>
            <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setSelling('gift')}>+ {t('sales.sellGift')}</button>
          </div>
        )}
      </div>
      {plans.length === 0 && cards.length === 0 && <p className="text-sm text-slate-500">{t('sales.customerEmpty')}</p>}
      <ul className="space-y-2">
        {plans.map((p) => (
          <li key={p.id} className={`rounded-lg border p-3 text-sm ${p.status === 'active' ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 opacity-70'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">{t(`sales.status.${p.status}`)}</span>
              </div>
              <span className="font-semibold text-emerald-800" data-testid="sessions-left">
                {p.sessionsLeft == null ? t('sales.unlimited') : t('sales.left', { count: p.sessionsLeft })}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {t(`sales.kind.${p.kind}`)} · {t('sales.usedOf', { used: p.sessionsUsed, total: p.sessionsTotal ?? '∞' })}
              {p.expiresOn && ` · ${t('sales.expires', { date: dateOnly(p.expiresOn) })}`}
            </div>
            <div className="mt-1 flex gap-3 text-xs">
              {p.uses.length > 0 && <button type="button" className="text-brand-700 hover:underline" onClick={() => setOpen(open === p.id ? null : p.id)}>{t('sales.history', { count: p.uses.length })}</button>}
              {manager && p.status === 'active' && <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('sales.cancelConfirm')) && cancel.mutate(p.id)}>{t('sales.cancelPlan')}</button>}
            </div>
            {open === p.id && (
              <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                {p.uses.map((u) => <li key={u.appointmentId}>· {dateOnly(u.startsAt)} — {u.serviceName}{u.sessions > 1 ? ` (×${u.sessions})` : ''}</li>)}
              </ul>
            )}
          </li>
        ))}
        {cards.map((g) => (
          <li key={g.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm">
            <div>
              🎁 <span className="font-mono font-semibold">{g.code}</span>
              {g.recipientName && <span className="ml-2 text-xs text-slate-500">{t('sales.for', { name: g.recipientName })}</span>}
            </div>
            <span>{t('sales.balance')}: <b>{money(g.balanceCents)}</b></span>
          </li>
        ))}
      </ul>
      {selling === 'plan' && <SellPlanModal customerId={customerId} onClose={() => setSelling(null)} />}
      {selling === 'gift' && <SellGiftModal customerId={customerId} onClose={() => setSelling(null)} />}
    </section>
  );
}

function SellPlanModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const offers = useQuery({ queryKey: ['offerings'], queryFn: () => api<OfferingDto[]>('/offerings') });
  const active = (offers.data ?? []).filter((o) => o.active);
  const [offeringId, setOfferingId] = useState('');
  const [method, setMethod] = useState<(typeof SALE_METHODS)[number]>('cash');
  const [price, setPrice] = useState('');
  const chosen = active.find((o) => o.id === offeringId);
  const sell = useMutation({
    mutationFn: () => api(`/customers/${customerId}/plans`, { method: 'POST', body: { offeringId, method, ...(price !== '' ? { priceCents: toCents(price) } : {}) } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer-plans', customerId] });
      void qc.invalidateQueries({ queryKey: ['customer', customerId] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
  });
  return (
    <Modal open title={t('sales.sellPlan')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); sell.mutate(); }}>
        {active.length === 0 && !offers.isLoading && <p className="text-sm text-slate-500">{t('sales.emptyCatalogHint')}</p>}
        <div>
          <label className="label" htmlFor="sp-off">{t('sales.what')}</label>
          <select id="sp-off" required className="input" value={offeringId} onChange={(e) => { setOfferingId(e.target.value); setPrice(''); }}>
            <option value="">{t('sales.choose')}</option>
            {active.map((o) => <option key={o.id} value={o.id}>{o.name} · {money(o.priceCents)}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="sp-price">{t('sales.charged')}</label>
            <input id="sp-price" type="number" min={0} step="0.01" className="input" placeholder={chosen ? String(chosen.priceCents / 100) : ''} value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="sp-method">{t('agenda.paymentMethod')}</label>
            <select id="sp-method" className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {SALE_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">{t('sales.onlineLater')}</p>
        <ErrorText error={sell.error} ns="sales" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={sell.isPending || !offeringId}>{t('sales.sell')}</button>
        </div>
      </form>
    </Modal>
  );
}

function SellGiftModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('500');
  const [recipient, setRecipient] = useState('');
  const [expires, setExpires] = useState('');
  const [method, setMethod] = useState<(typeof SALE_METHODS)[number]>('cash');
  const [code, setCode] = useState<string | null>(null);
  const sell = useMutation({
    mutationFn: () => api<{ code: string }>('/gift-cards', { method: 'POST', body: { amountCents: toCents(amount), method, customerId, recipientName: recipient || null, expiresOn: expires || null } }),
    onSuccess: (r) => {
      setCode(r.code);
      void qc.invalidateQueries({ queryKey: ['customer-plans', customerId] });
      void qc.invalidateQueries({ queryKey: ['gift-cards'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
  });
  return (
    <Modal open title={t('sales.sellGift')} onClose={onClose}>
      {code ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-slate-600">{t('sales.giftReady')}</p>
          <p className="font-mono text-3xl font-bold tracking-widest" data-testid="gift-code">{code}</p>
          <button className="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); sell.mutate(); }}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="gc-amount">{t('sales.giftAmount')}</label>
              <input id="gc-amount" required type="number" min={1} step="0.01" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="gc-method">{t('agenda.paymentMethod')}</label>
              <select id="gc-method" className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {SALE_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="gc-to">{t('sales.recipient')}</label>
              <input id="gc-to" className="input" placeholder={t('common.optional')} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="gc-exp">{t('sales.expiresOn')}</label>
              <input id="gc-exp" type="date" className="input" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </div>
          </div>
          <ErrorText error={sell.error} ns="sales" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={sell.isPending}>{t('sales.sell')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
