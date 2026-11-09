import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROFESSIONAL_COLORS, type ProfessionalDto, type SessionUser } from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useProfessionals, useServices } from '../lib/queries';

/**
 * Team members who attend customers. With one or more active members each person gets
 * their own agenda and customers can pick who attends them.
 */
export function TeamPage() {
  const { t } = useTranslation();
  const { user, tenant } = useAuth();
  const isOwner = user?.role === 'owner' || user?.role === 'admin';
  const isClasses = tenant?.kind === 'classes';
  const pros = useProfessionals();
  const services = useServices();
  const [editing, setEditing] = useState<ProfessionalDto | 'new' | null>(null);
  const list = pros.data ?? [];
  const svcName = new Map((services.data ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader
        title={isClasses ? t('team.instructorsTitle') : t('team.title')}
        actions={isOwner && <button className="btn-primary" onClick={() => setEditing('new')}>{t('team.add')}</button>}
      />
      <p className="-mt-4 mb-4 max-w-2xl text-sm text-slate-500">{isClasses ? t('team.instructorsHelp') : t('team.help')}</p>
      {pros.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{isClasses ? t('team.emptyInstructors') : t('team.empty')}</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <button
              key={p.id}
              disabled={!isOwner}
              onClick={() => setEditing(p)}
              className={`card !p-4 text-left ${p.active ? '' : 'opacity-60'} ${isOwner ? 'hover:border-brand-500' : ''}`}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: p.color }}>
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {!p.active
                      ? t('services.inactive')
                      : p.serviceIds.length
                        ? p.serviceIds.map((id) => svcName.get(id)).filter(Boolean).join(', ')
                        : t('team.allServices')}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && <ProfessionalModal pro={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProfessionalModal({ pro, onClose }: { pro: ProfessionalDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const services = useServices();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<SessionUser[]>('/users') });
  const [form, setForm] = useState({
    name: pro?.name ?? '',
    color: pro?.color ?? PROFESSIONAL_COLORS[Math.floor(Math.random() * PROFESSIONAL_COLORS.length)]!,
    active: pro?.active ?? true,
    serviceIds: pro?.serviceIds ?? [],
    userId: pro?.userId ?? '',
  });
  const [info, setInfo] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['professionals'] });
    void qc.invalidateQueries({ queryKey: ['appointments'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<ProfessionalDto>(pro ? `/professionals/${pro.id}` : '/professionals', {
        method: pro ? 'PUT' : 'POST',
        body: { ...form, userId: form.userId || null },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<{ deactivated?: boolean } | undefined>(`/professionals/${pro!.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      refresh();
      if (r?.deactivated) setInfo(t('team.deactivated'));
      else onClose();
    },
  });
  const active = (services.data ?? []).filter((s) => s.active);
  const toggle = (id: string) =>
    setForm((f) => ({ ...f, serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((x) => x !== id) : [...f.serviceIds, id] }));

  return (
    <Modal open title={pro ? t('team.edit') : t('team.add')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label">{t('team.name')}</label>
          <input required maxLength={80} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <div className="label">{t('team.color')}</div>
          <div className="flex flex-wrap gap-2">
            {PROFESSIONAL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={form.color === c}
                onClick={() => setForm({ ...form, color: c })}
                className={`h-8 w-8 rounded-full border-2 ${form.color === c ? 'border-slate-900' : 'border-white'} shadow`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="label">{t('team.services')}</div>
          <p className="mb-2 text-xs text-slate-500">{t('team.servicesHelp')}</p>
          <div className="flex flex-wrap gap-2">
            {active.map((s) => {
              const on = form.serviceIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-pressed={on}
                  className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-600'}`}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="label">{t('team.login')}</label>
          <select className="input" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
            <option value="">{t('team.noLogin')}</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          {t('team.activeLabel')}
        </label>
        {info && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{info}</p>}
        <ErrorText error={save.error ?? remove.error} ns="team" />
        <div className="flex items-center justify-between">
          {pro ? (
            <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => window.confirm(t('team.deleteConfirm')) && remove.mutate()}>
              {t('common.delete')}
            </button>
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
