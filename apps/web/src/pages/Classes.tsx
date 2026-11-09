import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import { paymentSettingsOf, type AppointmentDto, type ClassSessionDto, type CustomerDto } from '@agenda/shared';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { dateLocale, dateTime, money, timeOnly, toLocalInput } from '../lib/format';
import { useCustomers, useProfessionals, useServices } from '../lib/queries';

/** Week view of group classes; each class shows spots taken and opens its attendee list. */
export function ClassesPage() {
  const { t } = useTranslation();
  // Colaboradores (instructors) see only their own classes and can't schedule new ones.
  const { manager, unlinked } = useAccess();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [creating, setCreating] = useState<Date | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const to = addDays(weekStart, 7);
  const sessions = useQuery({
    queryKey: ['class-sessions', weekStart.toISOString()],
    queryFn: () =>
      api<ClassSessionDto[]>(`/class-sessions?from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  });
  const today = new Date();
  const newAt = (d: Date) => {
    const base = new Date(d);
    if (isSameDay(base, today)) base.setHours(today.getHours() + 1, 0, 0, 0);
    else base.setHours(8, 0, 0, 0);
    return base;
  };

  return (
    <>
      <PageHeader
        title={t('classes.title')}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="prev">‹</button>
            <button className="btn-secondary" onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}>{t('agenda.today')}</button>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="next">›</button>
            {manager && <button className="btn-primary" onClick={() => setCreating(newAt(new Date()))}>{t('classes.new')}</button>}
          </>
        }
      />
      <p className="-mt-4 mb-4 text-sm text-slate-500">
        {format(weekStart, 'd MMM', { locale: dateLocale() })} – {format(addDays(weekStart, 6), 'd MMM yyyy', { locale: dateLocale() })}
      </p>
      {unlinked && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('roles.notLinked')}</p>}
      {!manager && !unlinked && <p className="mb-4 text-sm text-slate-500">{t('roles.onlyYourClasses')}</p>}
      {sessions.isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-3 lg:grid-cols-7">
          {days.map((d) => {
            const items = (sessions.data ?? []).filter((s) => isSameDay(new Date(s.startsAt), d));
            const isToday = isSameDay(d, today);
            return (
              <div key={d.toISOString()} className={`rounded-xl border bg-white p-2 ${isToday ? 'border-brand-500' : 'border-slate-200'}`}>
                <button className="mb-2 flex w-full items-baseline justify-between rounded px-1 text-left hover:bg-slate-50" onClick={() => setCreating(newAt(d))} title={t('classes.new')}>
                  <span className={`text-sm font-semibold capitalize ${isToday ? 'text-brand-700' : 'text-slate-700'}`}>{format(d, 'EEE d', { locale: dateLocale() })}</span>
                  <span className="text-lg leading-none text-slate-400">+</span>
                </button>
                <div className="space-y-1.5">
                  {items.length === 0 && <p className="px-1 text-xs text-slate-400">{t('classes.empty')}</p>}
                  {items.map((s) => {
                    const pct = Math.min(100, Math.round((s.booked / s.capacity) * 100));
                    const cancelled = s.status === 'cancelled';
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelected(s.id)}
                        className={`w-full rounded-lg border border-slate-200 p-2 text-left text-xs hover:border-brand-500 ${cancelled ? 'opacity-50' : ''}`}
                        style={{ borderLeft: `4px solid ${s.professionalColor ?? '#94a3b8'}` }}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold text-slate-800">{timeOnly(s.startsAt)}</span>
                          <span className={`font-medium ${s.booked >= s.capacity ? 'text-rose-700' : 'text-slate-600'}`}>
                            {cancelled ? t('classes.cancelled') : `${s.booked}/${s.capacity}`}
                          </span>
                        </div>
                        <div className={`mt-1 truncate font-medium text-slate-700 ${cancelled ? 'line-through' : ''}`}>{s.serviceName}</div>
                        {s.professionalName && <div className="truncate text-slate-500">{s.professionalName}</div>}
                        {!cancelled && (
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full ${pct >= 100 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && <NewSessionModal initial={creating} onClose={() => setCreating(null)} />}
      {selected && <SessionModal id={selected} onClose={() => setSelected(null)} onOpen={setSelected} />}
    </>
  );
}

function NewSessionModal({ initial, onClose }: { initial: Date; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const services = useServices();
  const pros = useProfessionals();
  const active = (services.data ?? []).filter((s) => s.active);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState('');
  const [professionalId, setProfessionalId] = useState('');
  const [capacity, setCapacity] = useState('12');
  const [notes, setNotes] = useState('');
  const svc = active.find((s) => s.id === (serviceId || active[0]?.id));
  const create = useMutation({
    mutationFn: () =>
      api<ClassSessionDto>('/class-sessions', {
        method: 'POST',
        body: {
          serviceId: svc!.id,
          startsAt: new Date(startsAt).toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          professionalId: professionalId || null,
          capacity: Number(capacity),
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['class-sessions'] });
      onClose();
    },
  });
  return (
    <Modal open title={t('classes.new')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div>
          <label className="label">{t('classes.classType')}</label>
          <select required className="input" value={svc?.id ?? ''} onChange={(e) => { setServiceId(e.target.value); setDuration(''); }}>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</option>)}
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">{t('agenda.startsAt')}</label>
            <input type="datetime-local" required className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('agenda.duration')}</label>
            <input type="number" min={5} max={600} className="input" placeholder={svc ? String(svc.durationMin) : ''} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('classes.capacity')}</label>
            <input type="number" min={1} max={500} required className="input" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">{t('classes.instructor')}</label>
          <select className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="">{t('classes.noInstructor')}</option>
            {(pros.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">{t('agenda.notes')}</label>
          <input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <ErrorText error={create.error} ns="classes" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={create.isPending || !svc}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

function SessionModal({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant } = useAuth();
  const { manager } = useAccess();
  const pros = useProfessionals();
  const pay = paymentSettingsOf(tenant!.settings);
  const inPerson = (['cash', 'card', 'transfer'] as const).filter((m) => pay.methods[m]);
  const methods = inPerson.length ? inPerson : (['cash', 'card', 'transfer'] as const);
  const [method, setMethod] = useState<(typeof methods)[number]>(methods[0]!);
  const q = useQuery({
    queryKey: ['class-session', id],
    queryFn: () => api<{ session: ClassSessionDto; attendees: AppointmentDto[] }>(`/class-sessions/${id}`),
  });
  const [edit, setEdit] = useState<{ startsAt: string; capacity: string; professionalId: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['class-sessions'] });
    void qc.invalidateQueries({ queryKey: ['class-session', id] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const patchSession = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/class-sessions/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEdit(null);
      refresh();
    },
  });
  const copy = useMutation({
    mutationFn: () => api<ClassSessionDto>(`/class-sessions/${id}/copy`, { method: 'POST', body: { days: 7 } }),
    onSuccess: (s) => {
      refresh();
      onOpen(s.id);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api(`/class-sessions/${id}/cancel`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/class-sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const attendee = useMutation({
    mutationFn: ({ apptId, body }: { apptId: string; body: Record<string, unknown> }) => api(`/appointments/${apptId}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });

  if (q.isLoading || !q.data) return <Modal open title={t('classes.title')} onClose={onClose}><Loading /></Modal>;
  const { session: s, attendees } = q.data;
  const cancelled = s.status === 'cancelled';
  const left = Math.max(0, s.capacity - s.booked);

  return (
    <Modal open title={s.serviceName} onClose={onClose}>
      <div className="space-y-1">
        <div className="text-sm text-slate-600">{dateTime(s.startsAt)} – {timeOnly(s.endsAt)}</div>
        {s.professionalName && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.professionalColor ?? '#94a3b8' }} />
            {s.professionalName}
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-slate-500">{t('classes.capacity')}</div><div className="font-semibold">{s.capacity}</div></div>
          <div><div className="text-slate-500">{t('classes.booked')}</div><div className="font-semibold">{s.booked}</div></div>
          <div><div className="text-slate-500">{t('classes.left')}</div><div className={`font-semibold ${left ? 'text-emerald-700' : 'text-rose-700'}`}>{left}</div></div>
        </div>
        {cancelled && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{t('classes.cancelledHelp')}</p>}
        {s.notes && <p className="rounded-lg bg-slate-50 p-2 text-sm">{s.notes}</p>}
      </div>

      {!cancelled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => setAdding(!adding)}>{t('classes.addAttendee')}</button>
          {manager && (
            <>
              <button className="btn-secondary" onClick={() => setEdit(edit ? null : { startsAt: toLocalInput(new Date(s.startsAt)), capacity: String(s.capacity), professionalId: s.professionalId ?? '' })}>{t('common.edit')}</button>
              <button className="btn-secondary" disabled={copy.isPending} onClick={() => copy.mutate()}>{t('classes.copyNextWeek')}</button>
              <button className="btn-secondary text-rose-700" onClick={() => window.confirm(t('classes.cancelConfirm')) && cancel.mutate()}>{t('classes.cancelClass')}</button>
            </>
          )}
        </div>
      )}

      {edit && (
        <form
          className="mt-3 grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            patchSession.mutate({ startsAt: new Date(edit.startsAt).toISOString(), capacity: Number(edit.capacity), professionalId: edit.professionalId || null });
          }}
        >
          <input type="datetime-local" required className="input sm:col-span-3" value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} />
          <input type="number" min={1} max={500} required className="input" aria-label={t('classes.capacity')} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} />
          <select className="input" value={edit.professionalId} onChange={(e) => setEdit({ ...edit, professionalId: e.target.value })} aria-label={t('classes.instructor')}>
            <option value="">{t('classes.noInstructor')}</option>
            {(pros.data ?? []).filter((p) => p.active || p.id === s.professionalId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn-primary" disabled={patchSession.isPending}>{t('common.save')}</button>
          <div className="sm:col-span-3"><ErrorText error={patchSession.error} ns="classes" /></div>
        </form>
      )}

      {adding && !cancelled && <AddAttendee sessionId={id} onDone={() => { setAdding(false); refresh(); }} />}

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">{t('classes.attendees')} ({attendees.filter((a) => a.status !== 'cancelled').length})</h3>
          {attendees.some((a) => a.status === 'scheduled' || a.status === 'confirmed') && (
            <select className="input w-auto !py-1 text-sm" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label={t('agenda.paymentMethod')}>
              {methods.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
            </select>
          )}
        </div>
        {attendees.length === 0 ? (
          <p className="text-sm text-slate-500">{t('classes.noAttendees')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {attendees.map((a) => {
              const open = a.status === 'scheduled' || a.status === 'confirmed';
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{a.customerName}{(a.partySize ?? 1) > 1 && <span className="text-slate-500"> · {t('classes.spotsN', { count: a.partySize ?? 1 })}</span>}</div>
                    <div className="text-xs text-slate-500">{a.customerPhone ?? ''} {a.source === 'online' ? `· ${t('source.online')}` : ''} · {money(a.priceCents)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={a.status} />
                    {open && !cancelled && (
                      <>
                        <button className="text-emerald-700" onClick={() => attendee.mutate({ apptId: a.id, body: { status: 'completed', paymentMethod: method } })}>{t('classes.attended')}</button>
                        <button className="text-amber-700" onClick={() => attendee.mutate({ apptId: a.id, body: { status: 'no_show' } })}>{t('agenda.noShow')}</button>
                        <button className="text-rose-700" onClick={() => attendee.mutate({ apptId: a.id, body: { status: 'cancelled' } })}>{t('classes.remove')}</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ErrorText error={copy.error ?? cancel.error ?? remove.error ?? attendee.error} ns="classes" />
      <div className="mt-6 flex justify-between">
        {manager && attendees.length === 0 ? (
          <button className="text-sm text-rose-700 hover:underline" onClick={() => window.confirm(t('classes.deleteConfirm')) && remove.mutate()}>{t('common.delete')}</button>
        ) : <span />}
        <button className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

function AddAttendee({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { manager, scoped } = useAccess();
  const [search, setSearch] = useState('');
  const customers = useCustomers(search, 'name', scoped);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [spots, setSpots] = useState('1');
  const [overbook, setOverbook] = useState(false);
  const add = useMutation({
    mutationFn: async () => {
      let cid = customerId;
      if (newCustomer) {
        cid = (await api<CustomerDto>('/customers', { method: 'POST', body: { name: newCustomer.name, phone: newCustomer.phone || null } })).id;
      }
      return api('/appointments', { method: 'POST', body: { customerId: cid, classSessionId: sessionId, partySize: Number(spots), allowOverlap: overbook } });
    },
    onSuccess: onDone,
  });
  return (
    <form className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <div className="flex items-center justify-between">
        <span className="label mb-0">{t('agenda.customer')}</span>
        <button type="button" className="text-sm font-medium text-brand-700" onClick={() => setNewCustomer(newCustomer ? null : { name: '', phone: '' })}>
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
          <input placeholder={t('customers.searchPlaceholder')} className="input" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select required className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} size={Math.min(5, Math.max(2, customers.data?.items.length ?? 2))}>
            {(customers.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
          </select>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t('classes.spots')}
          <input type="number" min={1} max={10} className="input w-20" value={spots} onChange={(e) => setSpots(e.target.value)} />
        </label>
        {manager && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={overbook} onChange={(e) => setOverbook(e.target.checked)} />
            {t('classes.overbook')}
          </label>
        )}
        <button className="btn-primary ml-auto" disabled={add.isPending}>{t('common.save')}</button>
      </div>
      <ErrorText error={add.error} ns="classes" />
    </form>
  );
}
