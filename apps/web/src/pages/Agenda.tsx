import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import { computeDepositCents, eligibleProfessionals, paymentSettingsOf, rentalSettingsOf, selfServiceOf, spacePriceCents, type AppointmentDto, type CustomerDto, type PaymentDto, type TableDto } from '@agenda/shared';
import { useAuth } from '../lib/auth';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money, timeOnly, toCents, toLocalInput } from '../lib/format';
import { useCustomers, useProfessionals, useServices, useSpaces } from '../lib/queries';

const useTables = (enabled: boolean) =>
  useQuery({ queryKey: ['tables'], queryFn: () => api<TableDto[]>('/tables'), enabled });

export function AgendaPage() {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const isRestaurant = tenant?.kind === 'reservations';
  const isRentals = tenant?.kind === 'rentals';
  const pros = useProfessionals(tenant?.kind === 'appointments');
  const spaces = useSpaces(isRentals);
  // Filter chips: one per professional (team) or space (rentals)
  const resources = isRentals
    ? (spaces.data ?? []).filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, color: '#64748b' }))
    : (pros.data ?? []).filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, color: x.color }));
  const [filter, setFilter] = useState('');
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
        title={isRestaurant ? t('nav.reservations') : isRentals ? t('nav.bookings') : t('agenda.title')}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="prev">‹</button>
            <button className="btn-secondary" onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
              {t('agenda.today')}
            </button>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="next">›</button>
            <button className="btn-primary" onClick={() => setCreating(newAt(new Date()))}>{isRestaurant ? t('tables.newReservation') : t('agenda.new')}</button>
          </>
        }
      />
      <p className="-mt-4 mb-4 text-sm text-slate-500">
        {format(weekStart, 'd MMM', { locale: dateLocale() })} – {format(addDays(weekStart, 6), 'd MMM yyyy', { locale: dateLocale() })}
      </p>
      {resources.length > 1 && (
        <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('agenda.filter')}>
          <button
            onClick={() => setFilter('')}
            aria-pressed={!filter}
            className={`whitespace-nowrap rounded-full border px-3 py-1 text-sm ${!filter ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
          >
            {t('agenda.everyone')}
          </button>
          {resources.map((r) => (
            <button
              key={r.id}
              onClick={() => setFilter(filter === r.id ? '' : r.id)}
              aria-pressed={filter === r.id}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-sm ${filter === r.id ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              {r.name}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-3 lg:grid-cols-7">
          {days.map((d) => {
            const items = (data ?? []).filter(
              (a) => isSameDay(new Date(a.startsAt), d) && (!filter || a.professionalId === filter || a.spaceId === filter),
            );
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
                      style={a.professionalColor ? { borderLeft: `4px solid ${a.professionalColor}` } : undefined}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-slate-800">{timeOnly(a.startsAt)}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="mt-1 truncate font-medium text-slate-700">{a.customerName}</div>
                      <div className="truncate text-slate-500">
                        {a.tableId || (isRestaurant && a.partySize)
                          ? `${t('tables.people', { count: a.partySize ?? 0 })}${a.tableName ? ` · ${a.tableName}` : ''}`
                          : a.spaceName
                            ? `${a.spaceName} · ${Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000)} ${t('common.minutes')}`
                            : a.serviceName}
                      </div>
                      {a.professionalName && <div className="truncate text-slate-400">{a.professionalName}</div>}
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
  const { tenant } = useAuth();
  const isRestaurant = tenant?.kind === 'reservations';
  const isRentals = tenant?.kind === 'rentals';
  const tables = useTables(isRestaurant);
  const pros = useProfessionals(tenant?.kind === 'appointments');
  const spaces = useSpaces(isRentals);
  const durations = rentalSettingsOf(tenant!.settings).durations;
  const [professionalId, setProfessionalId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [partySize, setPartySize] = useState('2');
  const [tableId, setTableId] = useState('');
  const services = useServices();
  const [search, setSearch] = useState('');
  const customers = useCustomers(search);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState(isRentals ? String(durations[0]) : '');
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
          serviceId: isRentals ? undefined : serviceId || active[0]?.id,
          startsAt: new Date(startsAt).toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          priceCents: isRestaurant ? 0 : price !== '' ? toCents(price) : undefined,
          notes: notes || null,
          allowOverlap,
          ...(isRestaurant ? { partySize: Number(partySize), tableId: tableId || null } : {}),
          ...(isRentals ? { spaceId: spaceId || null } : {}),
          ...(teamPros.length ? { professionalId: professionalId || null } : {}),
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

  const teamPros = (pros.data ?? []).filter((p) => p.active);
  const eligible = eligibleProfessionals(teamPros, serviceId || active[0]?.id);
  const space = (spaces.data ?? []).find((x) => x.id === spaceId);
  const pickService = (id: string) => {
    setServiceId(id);
    const s = active.find((x) => x.id === id);
    if (s) {
      setDuration(String(s.durationMin));
      setPrice(String(s.priceCents / 100));
    }
  };

  return (
    <Modal open title={isRestaurant ? t('tables.newReservation') : t('agenda.new')} onClose={onClose}>
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
        {isRestaurant ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('tables.partySize')}</label>
              <input type="number" min={1} max={50} required className="input" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
            </div>
            <div>
              <label className="label">{t('tables.table')}</label>
              <select className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">{t('tables.auto')}</option>
                {(tables.data ?? []).filter((x) => x.active && x.seats >= Number(partySize || 1)).map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · {t('tables.seatsN', { count: x.seats })}{x.area ? ` · ${x.area}` : ''}</option>
                ))}
              </select>
            </div>
          </div>
        ) : isRentals ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('spaces.space')}</label>
              <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                <option value="">{t('spaces.auto')}</option>
                {(spaces.data ?? []).filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · {t('spaces.perHour', { price: money(x.pricePerHourCents) })}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('agenda.duration')}</label>
              <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {durations.map((m) => <option key={m} value={m}>{m} {t('common.minutes')}</option>)}
              </select>
            </div>
          </div>
        ) : (
        <div>
          <label className="label">{t('agenda.service')}</label>
          <select required className="input" value={serviceId} onChange={(e) => pickService(e.target.value)}>
            <option value="">{t('agenda.selectService')}</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</option>
            ))}
          </select>
          {teamPros.length > 0 && (
            <div className="mt-4">
              <label className="label">{t('team.professional')}</label>
              <select className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
                <option value="">{t('team.auto')}</option>
                {eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <input type="datetime-local" required className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          {!isRentals && (
          <div>
            <label className="label">{t('agenda.duration')}</label>
            <input type="number" min={5} className="input" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          )}
          {!isRestaurant && (
          <div>
            <label className="label">{t('agenda.price')}</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              placeholder={isRentals && space ? String(spacePriceCents(space.pricePerHourCents, Number(duration)) / 100) : ''}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          )}
        </div>
        <div>
          <label className="label">{t('agenda.notes')}</label>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
          {isRestaurant ? t('tables.noTable') : isRentals ? t('spaces.noSpace') : t('agenda.allowOverlap')}
        </label>
        <ErrorText error={create.error} ns={isRestaurant ? 'tables' : 'agenda'} />
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
  const { tenant } = useAuth();
  const pay = paymentSettingsOf(tenant!.settings);
  const inPerson = (['cash', 'card', 'transfer'] as const).filter((m) => pay.methods[m]);
  const offline = inPerson.length ? inPerson : (['cash', 'card', 'transfer'] as const);
  const online = tenant?.mercadoPago.connected
    ? (['mercadopago', 'spei'] as const).filter((m) => pay.methods[m])
    : [];
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>(offline[0]!);
  const [reschedule, setReschedule] = useState(toLocalInput(new Date(appt.startsAt)));
  const [deposit, setDeposit] = useState<{ amount: string; method: 'mercadopago' | 'spei' } | null>(null);
  const [link, setLink] = useState<PaymentDto | null>(null);
  const outstanding = Math.max(appt.priceCents - appt.paidCents, 0);
  const selfService = selfServiceOf(tenant!.settings);
  const [copied, setCopied] = useState(false);
  const tablesQ = useTables(appt.tableId != null || tenant?.kind === 'reservations');
  const prosQ = useProfessionals(tenant?.kind === 'appointments');
  const spacesQ = useSpaces(tenant?.kind === 'rentals');
  const teamPros = eligibleProfessionals((prosQ.data ?? []).filter((p) => p.active), appt.serviceId);
  const [pro, setPro] = useState(appt.professionalId ?? '');
  const [spc, setSpc] = useState(appt.spaceId ?? '');
  const isTableBooking = tenant?.kind === 'reservations' && !appt.classSessionId;
  const [party, setParty] = useState(String(appt.partySize ?? 2));
  const [table, setTable] = useState(appt.tableId ?? '');
  const [bill, setBill] = useState('');
  const manageUrl = `${window.location.origin}${appt.managePath}`;
  const manageMsg = t('agenda.manageMessage', {
    name: appt.customerName.split(' ')[0],
    business: tenant!.name,
    date: dateTime(appt.startsAt),
    url: manageUrl,
  });

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
        {isTableBooking && appt.partySize != null && (
          <div className="text-sm font-medium text-slate-700">
            {t('tables.people', { count: appt.partySize })} · {appt.tableName ?? t('tables.unassigned')}
          </div>
        )}
        {(appt.professionalName || appt.spaceName) && (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            {appt.professionalColor && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: appt.professionalColor }} />}
            {appt.professionalName ?? appt.spaceName}
          </div>
        )}
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

          {teamPros.length > 0 && !appt.classSessionId && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('team.professional')}</label>
              <div className="flex flex-wrap gap-2">
                <select className="input w-auto" value={pro} onChange={(e) => setPro(e.target.value)}>
                  <option value="">{t('team.auto')}</option>
                  {teamPros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ professionalId: pro || null })}>{t('common.save')}</button>
              </div>
            </div>
          )}

          {tenant?.kind === 'rentals' && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('spaces.space')}</label>
              <div className="flex flex-wrap gap-2">
                <select className="input w-auto" value={spc} onChange={(e) => setSpc(e.target.value)}>
                  <option value="">{t('spaces.auto')}</option>
                  {(spacesQ.data ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ spaceId: spc || null })}>{t('common.save')}</button>
              </div>
            </div>
          )}

          {isTableBooking && appt.partySize != null && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('tables.table')}</label>
              <div className="flex flex-wrap gap-2">
                <input type="number" min={1} max={50} className="input w-24" value={party} onChange={(e) => setParty(e.target.value)} aria-label={t('tables.partySize')} />
                <select className="input w-auto" value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">{t('tables.auto')}</option>
                  {(tablesQ.data ?? []).filter((x) => x.active && x.seats >= Number(party || 1)).map((x) => (
                    <option key={x.id} value={x.id}>{x.name} · {t('tables.seatsN', { count: x.seats })}</option>
                  ))}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ partySize: Number(party), tableId: table || null })}>{t('common.save')}</button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.paymentMethod')}</label>
            <div className="flex flex-wrap gap-2">
              <select className="input w-auto" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {offline.map((m) => (
                  <option key={m} value={m}>{t(`methods.${m}`)}</option>
                ))}
              </select>
              {isTableBooking && appt.partySize != null && (
                <input type="number" min={0} step="0.01" className="input w-32" placeholder={t('tables.bill')} value={bill} onChange={(e) => setBill(e.target.value)} aria-label={t('tables.bill')} />
              )}
              <button className="btn-primary" onClick={() => update.mutate({ status: 'completed', paymentMethod: method, ...(isTableBooking && bill !== '' ? { priceCents: toCents(bill) } : {}) })}>
                {t('agenda.complete')}
              </button>
            </div>
          </div>

          {!appt.classSessionId && <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <div className="flex flex-wrap gap-2">
              <input type="datetime-local" className="input w-auto" value={reschedule} onChange={(e) => setReschedule(e.target.value)} />
              <button className="btn-secondary" onClick={() => update.mutate({ startsAt: new Date(reschedule).toISOString() })}>
                {t('common.save')}
              </button>
            </div>
          </div>}

          {(selfService.rescheduleEnabled || selfService.cancelEnabled) && (
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <label className="label">{t('agenda.manageLink')}</label>
              <p className="mb-2 text-xs text-slate-500">{t('agenda.manageLinkHelp', { hours: selfService.minHoursNotice })}</p>
              <div className="flex flex-wrap gap-2">
                <input readOnly className="input min-w-0 flex-1" value={manageUrl} onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(manageUrl);
                    setCopied(true);
                  }}
                >
                  {copied ? t('common.copied') : t('common.copy')}
                </button>
                {waLink(manageMsg) && (
                  <a className="btn-secondary" href={waLink(manageMsg)} target="_blank" rel="noreferrer">WhatsApp</a>
                )}
              </div>
            </div>
          )}

          {online.length > 0 && <div className="rounded-lg border border-slate-200 p-3">
            {!deposit ? (
              <button className="text-sm font-medium text-brand-700" onClick={() => setDeposit({ amount: String((computeDepositCents(outstanding, pay) || Math.round(outstanding / 2)) / 100 || ''), method: online[0]! })}>
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
                  {online.map((m) => (
                    <option key={m} value={m}>{t(`methods.${m}`)}</option>
                  ))}
                </select>
                <button className="btn-primary" disabled={createLink.isPending} onClick={() => createLink.mutate()}>{t('agenda.createLink')}</button>
              </div>
            )}
            <ErrorText error={createLink.error} ns="agenda" />
          </div>}
        </div>
      )}

      <ErrorText error={update.error} ns={isTableBooking ? 'tables' : 'agenda'} />
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
