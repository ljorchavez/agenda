import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inPersonMethods, paymentSettingsOf, type AppointmentDto, type ClassSessionDto, type CustomerDto } from '@agenda/shared';
import { ErrorText, Loading, Modal, StatusBadge } from './ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { dateTime, money, timeOnly, toLocalInput } from '../lib/format';
import { useMyLocations, useResources, useServices } from '../lib/queries';
import { LocationSelect } from './Locations';
import { CustomerPicker } from './CustomerPicker';

/** Group classes: schedule one, and manage one (attendees, edit, copy, cancel). Opened from the calendar. */

export function NewSessionModal({ initial, defaultLocation, resourceId: preset, onClose }: { initial: Date; defaultLocation: string; resourceId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [locationId, setLocationId] = useState(defaultLocation || ownLocation || '');
  const effectiveLoc = locationId || locs.list[0]?.id || '';
  const qc = useQueryClient();
  const services = useServices();
  const pros = useResources();
  const active = (services.data ?? []).filter((s) => s.active);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState('');
  const [resourceId, setResourceId] = useState(preset ?? '');
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
          resourceId: resourceId || null,
          locationId: effectiveLoc || undefined,
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
        {locs.multi && (
          <div>
            <label className="label" htmlFor="cs-loc">{t('locations.location')}</label>
            <LocationSelect id="cs-loc" value={effectiveLoc} onChange={(v) => { setLocationId(v); setResourceId(''); }} list={locs.list} />
          </div>
        )}
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
          <select className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            <option value="">{t('classes.noInstructor')}</option>
            {(pros.data ?? []).filter((p) => p.active && (!effectiveLoc || p.locationId === effectiveLoc)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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

export function SessionModal({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant } = useAuth();
  const { manager } = useAccess();
  const pros = useResources();
  const pay = paymentSettingsOf(tenant!.settings);
  const methods = inPersonMethods(pay);
  const [method, setMethod] = useState<(typeof methods)[number]>(methods[0]!);
  const q = useQuery({
    queryKey: ['class-session', id],
    queryFn: () => api<{ session: ClassSessionDto; attendees: AppointmentDto[] }>(`/class-sessions/${id}`),
  });
  const [edit, setEdit] = useState<{ startsAt: string; capacity: string; resourceId: string } | null>(null);
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
        {s.resourceName && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.resourceColor ?? '#94a3b8' }} />
            {s.resourceName}
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
              <button className="btn-secondary" onClick={() => setEdit(edit ? null : { startsAt: toLocalInput(new Date(s.startsAt)), capacity: String(s.capacity), resourceId: s.resourceId ?? '' })}>{t('common.edit')}</button>
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
            patchSession.mutate({ startsAt: new Date(edit.startsAt).toISOString(), capacity: Number(edit.capacity), resourceId: edit.resourceId || null });
          }}
        >
          <input type="datetime-local" required className="input sm:col-span-3" value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} />
          <input type="number" min={1} max={500} required className="input" aria-label={t('classes.capacity')} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} />
          <select className="input" value={edit.resourceId} onChange={(e) => setEdit({ ...edit, resourceId: e.target.value })} aria-label={t('classes.instructor')}>
            <option value="">{t('classes.noInstructor')}</option>
            {(pros.data ?? []).filter((p) => p.active || p.id === s.resourceId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
      <span className="label mb-0">{t('agenda.customer')}</span>
      <CustomerPicker value={customerId} onChange={setCustomerId} forBooking={scoped} newCustomer={newCustomer} onNewCustomer={setNewCustomer} />
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
