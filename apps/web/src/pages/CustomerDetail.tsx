import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { paymentSettingsOf, type AppointmentStatus, type CustomerWithStats, type PaymentMethod, type PaymentStatus } from '@agenda/shared';
import { useAccess, useAuth } from '../lib/auth';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateOnly, dateTime, money, toCents } from '../lib/format';
import { CustomerFormModal } from './Customers';

interface Detail extends CustomerWithStats {
  appointments: {
    id: string;
    startsAt: string;
    status: AppointmentStatus;
    priceCents: number;
    paidCents: number;
    serviceName: string;
    notes: string | null;
  }[];
  payments: {
    id: string;
    amountCents: number;
    method: PaymentMethod;
    status: PaymentStatus;
    paidAt: string | null;
    createdAt: string;
  }[];
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const { manager, scoped } = useAccess();

  const { data, isLoading } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api<Detail>(`/customers/${id}`),
  });

  const remove = useMutation({
    mutationFn: () => api(`/customers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      navigate('/customers');
    },
  });

  if (isLoading || !data) return <Loading />;

  return (
    <>
      <PageHeader
        title={data.name}
        actions={
          <>
            {data.phone && (
              <a className="btn-secondary" href={`https://wa.me/${data.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a>
            )}
            {!scoped && <button className="btn-secondary" onClick={() => setPaying(true)}>{t('customers.addPayment')}</button>}
            <button className="btn-primary" onClick={() => setEditing(true)}>{t('common.edit')}</button>
          </>
        }
      />
      <p className="-mt-4 mb-6 text-sm text-slate-500">
        {[data.phone, data.email].filter(Boolean).join(' · ')}
        {' · '}
        {t('customers.since', { date: dateOnly(data.createdAt) })}
      </p>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label={t('customers.visits')} value={String(data.visits)} />
        <Stat label={t('customers.totalSpent')} value={money(data.totalSpentCents)} />
        <Stat label={t('customers.lastVisit')} value={data.lastVisitAt ? dateOnly(data.lastVisitAt) : t('common.none')} />
        <Stat
          label={t('customers.frequency')}
          value={data.avgDaysBetweenVisits != null ? t('customers.everyNDays', { count: data.avgDaysBetweenVisits }) : t('common.none')}
        />
        <Stat label={t('customers.noShows')} value={String(data.noShows)} />
      </div>

      {data.notes && <div className="card mt-6 whitespace-pre-wrap text-sm">{data.notes}</div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <h2 className="mb-3 font-semibold">{t('customers.history')}</h2>
          <ul className="divide-y divide-slate-100">
            {data.appointments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <div className="font-medium">{a.serviceName}</div>
                  <div className="text-slate-500">{dateTime(a.startsAt)}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span>{money(a.priceCents)}</span>
                  <StatusBadge status={a.status} />
                </div>
              </li>
            ))}
            {data.appointments.length === 0 && <li className="py-2 text-sm text-slate-500">{t('common.none')}</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-3 font-semibold">{t('customers.payments')}</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {data.payments.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <div>
                  <div>{t(`methods.${p.method}`)}</div>
                  <div className="text-xs text-slate-500">{dateOnly(p.paidAt ?? p.createdAt)} · {t(`paymentStatus.${p.status}`)}</div>
                </div>
                <div className="font-medium">{money(p.amountCents)}</div>
              </li>
            ))}
            {data.payments.length === 0 && <li className="py-2 text-slate-500">{t('common.none')}</li>}
          </ul>
        </section>
      </div>

      {manager && (
        <div className="mt-8">
          <button className="text-sm text-rose-700 hover:underline" onClick={() => window.confirm(t('customers.deleteConfirm')) && remove.mutate()}>
            {t('common.delete')}
          </button>
        </div>
      )}

      {editing && <CustomerFormModal customer={data} onClose={() => setEditing(false)} />}
      {paying && <PaymentModal customerId={id} onClose={() => setPaying(false)} />}
    </>
  );
}

function PaymentModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const { tenant } = useAuth();
  const pay = paymentSettingsOf(tenant!.settings);
  const enabled = (['cash', 'card', 'transfer', 'spei'] as const).filter((m) => pay.methods[m]);
  const options = enabled.length ? enabled : (['cash', 'card', 'transfer'] as const);
  const [method, setMethod] = useState<PaymentMethod>(options[0]!);
  const save = useMutation({
    mutationFn: () => api('/payments', { method: 'POST', body: { customerId, amountCents: toCents(amount), method, status: 'paid' } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', customerId] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });
  return (
    <Modal open title={t('customers.addPayment')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">{t('customers.amount')}</label>
            <input type="number" required min={1} step="0.01" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('payments.method')}</label>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {options.map((m) => (
                <option key={m} value={m}>{t(`methods.${m}`)}</option>
              ))}
            </select>
          </div>
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
