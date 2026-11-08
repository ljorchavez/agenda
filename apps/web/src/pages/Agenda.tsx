import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import type { AppointmentDto, CustomerDto, PaymentDto } from '@agenda/shared';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money, timeOnly, toCents, toLocalInput } from '../lib/format';
import { useCustomers, useServices } from '../lib/queries';

export function AgendaPage() {
  const { t } = useTranslation();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [creating, setCreating] = useState<Date | null>(null);
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const to = addDays(weekStart, 7);

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', weekStart.toISOString()],
    queryFn: () =>
      api<AppointmentDto[]>(
        `/appointments?from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      ),
  });

  const today = new Date();
  const newAt = (d: Date) => {
    const base = isSameDay(d, today) ? new Date() : new Date(d.setHours(10, 0, 0, 0));
    base.setMinutes(Math.ceil(base.getMinutes() / 30) * 30, 0, 0);
    return base;
  };

  return (
    <>
      <PageHeader
        title={t('agenda.title')}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="prev">‹</button>
            <button className="btn-secondary" onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
              {t('agenda.today')}
            </button>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="next">›</button>
            <button className="btn-primary" onClick={() => setCreating(newAt(new Date()))}>{t('agenda.new')}</button>
          </>
        }
      />
      <p className="-mt-4 mb-4 text-sm text-slate-500">
        {format(weekStart, 'd MMM', { locale: dateLocale() })} – {format(addDays(weekStart, 6), 'd MMM yyyy', { locale: dateLocale() })}
      </p>

      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-3 lg:grid-cols-7">
          {days.map((d) => {
            const items = (data ?? []).filter((a) => isSameDay(new Date(a.startsAt), d));
            const isToday = isSameDay(d, today);
            return (
              <div key={d.toISOString()} className={`rounded-xl border bg-white p-2 ${isToday ? 'border-brand-500' : 'border-slate-200'}`}>
                <button
                  className="mb-2 flex w-full items-baseline justify-between rounded px-1 text-left hover:bg-slate-50"
                  onClick={() => setCreating(newAt(new Date(d)))}
                  title={t('agenda.new')}
                >
                  <span className={`text-sm font-semibold capitalize ${isToday ? 'text-brand-700' : 'text-slate-700'}`}>
                    {format(d, 'EEE d', { locale: dateLocale() })}
                  </span>
                  <span className="text-lg leading-none text-slate-400">+</span>
                </button>
                <div className="space-y-1.5">
                  {items.length === 0 && <p className="px-1 text-xs text-slate-400">{t('agenda.empty')}</p>}
                  {items.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setSelected(a)}
                      className="w-full rounded-lg border border-slate-200 p-2 text-left text-xs hover:border-brand-500"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-slate-800">{timeOnly(a.startsAt)}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="mt-1 truncate font-medium text-slate-700">{a.customerName}</div>
                      <div className="truncate text-slate-500">{a.serviceName}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && <NewAppointmentModal initial={creating} onClose={() => setCreating(null)} />}
      {selected && <AppointmentModal appt={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function NewAppointmentModal({ initial, onClose }: { initial: Date; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const services = useServices();
  const [search, setSearch] = useState('');
  const customers = useCustomers(search);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState('');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [allowOverlap, setAllowOverlap] = useState(false);

  const active = (services.data ?? []).filter((s) => s.active);

  const create = useMutation({
    mutationFn: async () => {
      let cid = customerId;
      if (newCustomer) {
        const c = await api<CustomerDto>('/customers', {
          method: 'POST',
          body: { name: newCustomer.name, phone: newCustomer.phone || null },
        });
        cid = c.id;
      }
      return api<AppointmentDto>('/appointments', {
        method: 'POST',
        body: {
          customerId: cid,
          serviceId,
          startsAt: new Date(startsAt).toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          priceCents: price !== '' ? toCents(price) : undefined,
          notes: notes || null,
          allowOverlap,
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });

  const pickService = (id: string) => {
    setServiceId(id);
    const s = active.find((x) => x.id === id);
    if (s) {
      setDuration(String(s.durationMin));
      setPrice(String(s.priceCents / 100));
    }
  };

  return (
    <Modal open title={t('agenda.new')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="label mb-0">{t('agenda.customer')}</label>
            <button
              type="button"
              className="text-sm font-medium text-brand-700"
              onClick={() => setNewCustomer(newCustomer ? null : { name: '', phone: '' })}
            >
              {newCustomer ? t('common.cancel') : t('agenda.newCustomer')}
            </button>
          </div>
          {newCustomer ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input required placeholder={t('customers.name')} className="input" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
              <input type="tel" placeholder={t('customers.phone')} className="input" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
            </div>
          ) : (
            <>
              <input placeholder={t('customers.searchPlaceholder')} className="input mb-2" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select required className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} size={Math.min(5, Math.max(2, customers.data?.items.length ?? 2))}>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <div>
          <label className="label">{t('agenda.service')}</label>
          <select required className="input" value={serviceId} onChange={(e) => pickService(e.target.value)}>
            <option value="">{t('agenda.selectService')}</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <input type="datetime-local" required className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('agenda.duration')}</label>
            <input type="number" min={5} className="input" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('agenda.price')}</label>
            <input type="number" min={0} step="0.01" className="input" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">{t('agenda.notes')}</label>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
          {t('agenda.allowOverlap')}
        </label>
        <ErrorText error={create.error} ns="agenda" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={create.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

function AppointmentModal({ appt, onClose }: { appt: AppointmentDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>('cash');
  const [reschedule, setReschedule] = useState(toLocalInput(new Date(appt.startsAt)));
  const [deposit, setDeposit] = useState<{ amount: string; method: 'mercadopago' | 'spei' } | null>(null);
  const [link, setLink] = useState<PaymentDto | null>(null);
  const outstanding = Math.max(appt.priceCents - appt.paidCents, 0);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['appointments'] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AppointmentDto>(`/appointments/${appt.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/appointments/${appt.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const createLink = useMutation({
    mutationFn: () =>
      api<PaymentDto>('/payments/link', {
        method: 'POST',
        body: { appointmentId: appt.id, amountCents: toCents(deposit!.amount), method: deposit!.method },
      }),
    onSuccess: (p) => {
      setLink(p);
      refresh();
    },
  });

  const open = appt.status === 'scheduled' || appt.status === 'confirmed';
  const waLink = (url: string) =>
    appt.customerPhone
      ? `https://wa.me/${appt.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(url)}`
      : undefined;

  return (
    <Modal open title={t('agenda.edit')} onClose={onClose}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{appt.customerName}</div>
          <StatusBadge status={appt.status} />
        </div>
        <div className="text-slate-600">{appt.serviceName}</div>
        <div className="text-sm text-slate-500">{dateTime(appt.startsAt)} – {timeOnly(appt.endsAt)} · {t(`source.${appt.source}`)}</div>
        {appt.customerPhone && <div className="text-sm text-slate-500">{appt.customerPhone}</div>}
        {appt.notes && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-sm">{appt.notes}</p>}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-slate-500">{t('agenda.price')}</div><div className="font-semibold">{money(appt.priceCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.paid')}</div><div className="font-semibold text-emerald-700">{money(appt.paidCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.outstanding')}</div><div className="font-semibold text-amber-700">{money(outstanding)}</div></div>
        </div>
      </div>

      {open && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {appt.status === 'scheduled' && (
              <button className="btn-secondary" onClick={() => update.mutate({ status: 'confirmed' })}>{t('agenda.confirm')}</button>
            )}
            <button className="btn-secondary" onClick={() => update.mutate({ status: 'no_show' })}>{t('agenda.noShow')}</button>
            <button className="btn-secondary text-rose-700" onClick={() => update.mutate({ status: 'cancelled' })}>{t('agenda.cancelAppt')}</button>
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.paymentMethod')}</label>
            <div className="flex flex-wrap gap-2">
              <select className="input w-auto" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {(['cash', 'card', 'transfer'] as const).map((m) => (
                  <option key={m} value={m}>{t(`methods.${m}`)}</option>
                ))}
              </select>
              <button className="btn-primary" onClick={() => update.mutate({ status: 'completed', paymentMethod: method })}>
                {t('agenda.complete')}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <div className="flex flex-wrap gap-2">
              <input type="datetime-local" className="input w-auto" value={reschedule} onChange={(e) => setReschedule(e.target.value)} />
              <button className="btn-secondary" onClick={() => update.mutate({ startsAt: new Date(reschedule).toISOString() })}>
                {t('common.save')}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            {!deposit ? (
              <button className="text-sm font-medium text-brand-700" onClick={() => setDeposit({ amount: String(outstanding / 100 / 2 || ''), method: 'mercadopago' })}>
                {t('agenda.requestDeposit')} →
              </button>
            ) : link?.checkoutUrl ? (
              <div className="space-y-2 text-sm">
                <p>{t('agenda.linkReady')}</p>
                <input readOnly className="input" value={link.checkoutUrl} onFocus={(e) => e.target.select()} />
                {waLink(link.checkoutUrl) && (
                  <a className="btn-primary" href={waLink(link.checkoutUrl)} target="_blank" rel="noreferrer">{t('agenda.sendWhatsapp')}</a>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="label">{t('agenda.depositAmount')}</label>
                  <input type="number" min={1} step="0.01" className="input w-32" value={deposit.amount} onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} />
                </div>
                <select className="input w-auto" value={deposit.method} onChange={(e) => setDeposit({ ...deposit, method: e.target.value as 'mercadopago' | 'spei' })}>
                  <option value="mercadopago">{t('methods.mercadopago')}</option>
                  <option value="spei">{t('methods.spei')}</option>
                </select>
                <button className="btn-primary" disabled={createLink.isPending} onClick={() => createLink.mutate()}>{t('agenda.createLink')}</button>
              </div>
            )}
            <ErrorText error={createLink.error} ns="agenda" />
          </div>
        </div>
      )}

      <ErrorText error={update.error} ns="agenda" />
      <div className="mt-6 flex justify-between">
        <button
          className="text-sm text-rose-700 hover:underline"
          onClick={() => window.confirm(t('agenda.deleteConfirm')) && remove.mutate()}
        >
          {t('common.delete')}
        </button>
        <button className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}
