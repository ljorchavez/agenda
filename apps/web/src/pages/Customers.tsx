import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CustomerDto } from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dateOnly, money } from '../lib/format';
import { useCustomers } from '../lib/queries';
import { SortTh, useSort, type SortDir } from '../components/SortableTable';
import { StarRating } from '../components/Rating';

/** Columns sorted on the server (the list is paginated); first click direction per column. */
type SortKey = 'name' | 'visits' | 'totalSpent' | 'rating' | 'lastVisit' | 'frequency' | 'nextAppointment';
const FIRST_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  visits: 'desc',
  totalSpent: 'desc',
  rating: 'desc',
  lastVisit: 'desc',
  frequency: 'asc',
  nextAppointment: 'asc',
};

export function CustomersPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const navigate = useNavigate();
  const { sort, toggle } = useSort<SortKey>({ key: 'name', dir: 'asc' }, FIRST_DIR);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const { data, isLoading } = useCustomers(debounced, `${sort.key}&dir=${sort.dir}`);

  return (
    <>
      <PageHeader title={t('customers.title')} actions={<button className="btn-primary" onClick={() => setCreating(true)}>{t('customers.new')}</button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-md flex-1" placeholder={t('customers.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty>{t('customers.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <SortTh label={t('customers.name')} k="name" sort={sort} onSort={toggle} />
                <SortTh label={t('customers.visits')} k="visits" sort={sort} onSort={toggle} align="right" />
                <SortTh label={t('customers.totalSpent')} k="totalSpent" sort={sort} onSort={toggle} align="right" />
                <SortTh label={t('rating.average')} k="rating" sort={sort} onSort={toggle} className="hidden sm:table-cell" />
                <SortTh label={t('customers.lastVisit')} k="lastVisit" sort={sort} onSort={toggle} className="hidden md:table-cell" />
                <SortTh label={t('customers.frequency')} k="frequency" sort={sort} onSort={toggle} className="hidden md:table-cell" />
                <SortTh label={t('customers.nextAppointment')} k="nextAppointment" sort={sort} onSort={toggle} className="hidden lg:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50"
                  onClick={() => navigate(`/customers/${c.id}`)}
                >
                  <td className="px-4 py-3">
                    {/* Real link: keyboard, middle-click and "open in new tab" keep working */}
                    <Link to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-slate-900 hover:text-brand-700">
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500">{c.phone ?? c.email ?? ''}</div>
                  </td>
                  <td className="px-4 py-3 text-right">{c.visits}</td>
                  <td className="px-4 py-3 text-right font-medium">{money(c.totalSpentCents)}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    {c.avgRating != null ? (
                      <span className="inline-flex items-center gap-1.5" title={t('rating.basedOn', { count: c.ratingCount })}>
                        <StarRating value={c.avgRating} size="sm" />
                        <span className="text-xs text-slate-500">{c.avgRating.toFixed(1)}</span>
                      </span>
                    ) : (
                      <span className="text-slate-400">{t('common.none')}</span>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">{c.lastVisitAt ? dateOnly(c.lastVisitAt) : t('common.none')}</td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {c.avgDaysBetweenVisits != null ? t('customers.everyNDays', { count: c.avgDaysBetweenVisits }) : t('common.none')}
                  </td>
                  <td className="hidden px-4 py-3 lg:table-cell">{c.nextAppointmentAt ? dateOnly(c.nextAppointmentAt) : t('common.none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CustomerFormModal onClose={() => setCreating(false)} />}
    </>
  );
}

export function CustomerFormModal({ customer, onClose }: { customer?: CustomerDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    birthday: customer?.birthday ?? '',
    notes: customer?.notes ?? '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () =>
      api<CustomerDto>(customer ? `/customers/${customer.id}` : '/customers', {
        method: customer ? 'PUT' : 'POST',
        body: {
          name: form.name,
          phone: form.phone || null,
          email: form.email || null,
          birthday: form.birthday || null,
          notes: form.notes || null,
        },
      }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['customer', c.id] });
      onClose();
      if (!customer) navigate(`/customers/${c.id}`);
    },
  });

  return (
    <Modal open title={customer ? customer.name : t('customers.new')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label">{t('customers.name')}</label>
          <input required className="input" value={form.name} onChange={set('name')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">{t('customers.phone')}</label>
            <input type="tel" className="input" placeholder="55 1234 5678" value={form.phone} onChange={set('phone')} />
          </div>
          <div>
            <label className="label">{t('customers.email')} <span className="text-slate-400">({t('common.optional')})</span></label>
            <input type="email" className="input" value={form.email} onChange={set('email')} />
          </div>
        </div>
        <div>
          <label className="label">{t('customers.birthday')} <span className="text-slate-400">({t('common.optional')})</span></label>
          <input type="date" className="input" value={form.birthday} onChange={set('birthday')} />
        </div>
        <div>
          <label className="label">{t('customers.notes')}</label>
          <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
        </div>
        <ErrorText error={save.error} ns="customers" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
