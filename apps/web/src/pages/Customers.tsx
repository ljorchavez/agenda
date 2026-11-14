import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CustomerDto, CustomerWithStats } from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader, Pager } from '../components/ui';
import { api } from '../lib/api';
import { dateOnly, money } from '../lib/format';
import { useCustomers } from '../lib/queries';
import { SortTh, useSort, type SortDir } from '../components/SortableTable';
import { StarRating } from '../components/Rating';
import { FILTER_CTRL } from '../components/FilterBar';
import { DataTable, useColumns } from '../components/Columns';
import { FiscalFields, fiscalPayload, useFiscalForm } from '../components/FiscalFields';

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

const PAGE_SIZE = 50;

export function CustomersPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const navigate = useNavigate();
  const { sort, toggle } = useSort<SortKey>({ key: 'name', dir: 'asc' }, FIRST_DIR);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(0);
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const { data, isLoading } = useCustomers(debounced, `${sort.key}&dir=${sort.dir}${archived ? '&archived=1' : ''}`, false, { size: PAGE_SIZE, index: page });
  // A new search or order starts again on page 1
  useEffect(() => setPage(0), [debounced, sort.key, sort.dir, archived]);
  const sortTh = (k: SortKey, label: string, extra: { align?: 'right' } = {}) => (key: string) => <SortTh key={key} label={label} k={k} sort={sort} onSort={toggle} {...extra} />;
  const none = <span className="text-slate-400">{t('common.none')}</span>;
  const { cols, menu } = useColumns<CustomerWithStats>('customers', [
    { key: 'number', label: 'ID', className: 'text-slate-500 tabular-nums', td: (c) => (c.number != null ? `#${c.number}` : '') },
    {
      key: 'name', label: t('customers.name'), required: true, th: sortTh('name', t('customers.name')),
      td: (c) => (
        <>
          {/* Real link: keyboard, middle-click and "open in new tab" keep working */}
          <Link to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-slate-900 hover:text-brand-700">{c.name}</Link>
          <div className="text-xs text-slate-500">{c.phone ?? c.email ?? ''}</div>
        </>
      ),
    },
    { key: 'phone', label: t('customers.phone'), hidden: true, className: 'whitespace-nowrap', td: (c) => c.phone ?? none },
    { key: 'email', label: t('customers.email'), hidden: true, td: (c) => c.email ?? none },
    { key: 'visits', label: t('customers.visits'), th: sortTh('visits', t('customers.visits'), { align: 'right' }), className: 'text-right', td: (c) => c.visits },
    { key: 'totalSpent', label: t('customers.totalSpent'), th: sortTh('totalSpent', t('customers.totalSpent'), { align: 'right' }), className: 'text-right font-medium', td: (c) => money(c.totalSpentCents) },
    {
      key: 'rating', label: t('rating.average'), th: sortTh('rating', t('rating.average')),
      td: (c) =>
        c.avgRating != null ? (
          <span className="inline-flex items-center gap-1.5" title={t('rating.basedOn', { count: c.ratingCount })}>
            <StarRating value={c.avgRating} size="sm" />
            <span className="text-xs text-slate-500">{c.avgRating.toFixed(1)}</span>
          </span>
        ) : none,
    },
    { key: 'lastVisit', label: t('customers.lastVisit'), th: sortTh('lastVisit', t('customers.lastVisit')), td: (c) => (c.lastVisitAt ? dateOnly(c.lastVisitAt) : none) },
    { key: 'frequency', label: t('customers.frequency'), th: sortTh('frequency', t('customers.frequency')), td: (c) => (c.avgDaysBetweenVisits != null ? t('customers.everyNDays', { count: c.avgDaysBetweenVisits }) : none) },
    { key: 'nextAppointment', label: t('customers.nextAppointment'), th: sortTh('nextAppointment', t('customers.nextAppointment')), td: (c) => (c.nextAppointmentAt ? dateOnly(c.nextAppointmentAt) : none) },
    { key: 'rfc', label: 'RFC', hidden: true, className: 'font-mono text-xs', td: (c) => c.fiscal?.rfc ?? none },
  ]);

  return (
    <>
      <PageHeader title={t('customers.title')} actions={<button className="btn-primary" onClick={() => setCreating(true)}>{t('customers.new')}</button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="search" className={`${FILTER_CTRL} w-full sm:!w-80`} aria-label={t('customers.searchPlaceholder')} placeholder={t('customers.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} data-testid="show-archived" />
          {t('customers.showArchived')}
        </label>
        <span className="ml-auto">{menu}</span>
      </div>

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty>{t('customers.empty')}</Empty>
      ) : (
        <DataTable cols={cols} rows={data.items} rowKey={(c) => c.id} onRowClick={(c) => navigate(`/customers/${c.id}`)} />
      )}
      {data && <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => { setPage(p); window.scrollTo({ top: 0 }); }} />}
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
  const [fiscal, setFiscal] = useFiscalForm(customer);
  // New customer: the constancia read before saving is kept once the customer exists
  const [pendingCsf, setPendingCsf] = useState<File | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const saved = await api<CustomerDto>(customer ? `/customers/${customer.id}` : '/customers', {
        method: customer ? 'PUT' : 'POST',
        body: {
          name: form.name,
          phone: form.phone || null,
          email: form.email || null,
          birthday: form.birthday || null,
          notes: form.notes || null,
          fiscal: fiscalPayload(fiscal),
        },
      });
      if (!customer && pendingCsf) {
        const fd = new FormData();
        fd.append('file', pendingCsf);
        // The customer is saved either way; the file is a nice-to-have
        await api(`/customers/${saved.id}/fiscal-doc`, { method: 'POST', body: fd }).catch(() => undefined);
      }
      return saved;
    },
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
        <FiscalFields value={fiscal} onChange={setFiscal} customer={customer} onPendingFile={setPendingCsf} />
        <ErrorText error={save.error} ns="customers" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
