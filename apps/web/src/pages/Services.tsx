import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceDto } from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { money, toCents } from '../lib/format';
import { useServices } from '../lib/queries';
import { useAccess, useAuth } from '../lib/auth';

export function ServicesPage() {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const { manager } = useAccess();
  const { data, isLoading } = useServices();
  const [editing, setEditing] = useState<ServiceDto | 'new' | null>(null);

  return (
    <>
      <PageHeader title={t(`kinds.${tenant?.kind ?? 'appointments'}.services`)} actions={manager && <button className="btn-primary" onClick={() => setEditing('new')}>{t('services.new')}</button>} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>{t('services.empty')}</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((s) => (
            <button key={s.id} disabled={!manager} onClick={() => setEditing(s)} className={`card text-left ${manager ? 'hover:border-brand-500' : ''} ${s.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold">{s.name}</div>
                {!s.active && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{t('services.inactive')}</span>}
              </div>
              <div className="mt-2 text-sm text-slate-600">
                {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && <ServiceModal service={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ServiceModal({ service, onClose }: { service?: ServiceDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(String(service?.durationMin ?? 30));
  const [price, setPrice] = useState(service ? String(service.priceCents / 100) : '');
  const [active, setActive] = useState(service?.active ?? true);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['services'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      api(service ? `/services/${service.id}` : '/services', {
        method: service ? 'PUT' : 'POST',
        body: { name, durationMin: Number(duration), priceCents: toCents(price || 0), active },
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api<{ deactivated?: boolean } | undefined>(`/services/${service!.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      if (r?.deactivated) window.alert(t('services.deactivated'));
      done();
    },
  });

  return (
    <Modal open title={service ? service.name : t('services.new')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label">{t('services.name')}</label>
          <input required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">{t('services.duration')}</label>
            <input type="number" required min={5} step={5} className="input" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('services.price')}</label>
            <input type="number" min={0} step="0.01" className="input" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('services.active')}
        </label>
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex items-center justify-between">
          {service ? (
            <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => remove.mutate()}>{t('common.delete')}</button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
