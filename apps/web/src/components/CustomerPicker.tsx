import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomerWithStats } from '@agenda/shared';
import { useCustomers } from '../lib/queries';

/**
 * Search box + tappable results (works the same on phones and desktop). Once picked, the customer
 * shows as a card with "Cambiar". Enter picks the first result.
 */
export function CustomerPicker({ value, onChange, forBooking }: { value: string; onChange: (id: string) => void; forBooking: boolean }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<CustomerWithStats | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);
  const customers = useCustomers(debounced, 'name', forBooking);
  const items = (customers.data?.items ?? []).slice(0, 8);

  const pick = (c: CustomerWithStats) => {
    setPicked(c);
    onChange(c.id);
  };

  if (value && picked?.id === value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-600 bg-brand-50 px-3 py-2" data-testid="picked-customer">
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-900">{picked.name}</div>
          {picked.phone && <div className="text-xs text-slate-600">{picked.phone}</div>}
        </div>
        <button
          type="button"
          className="shrink-0 text-sm font-medium text-brand-700 hover:underline"
          onClick={() => {
            setPicked(null);
            onChange('');
          }}
        >
          {t('agenda.changeCustomer')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        type="search"
        autoComplete="off"
        placeholder={t('customers.searchPlaceholder')}
        className="input"
        value={search}
        aria-label={t('agenda.customer')}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items[0]) pick(items[0]);
          }
        }}
      />
      <ul className="mt-2 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" role="listbox" aria-label={t('agenda.customer')}>
        {customers.isLoading && <li className="px-3 py-2 text-sm text-slate-500">{t('common.loading')}</li>}
        {!customers.isLoading && items.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t('agenda.noCustomerFound')}</li>}
        {items.map((c) => (
          <li key={c.id} role="option" aria-selected={false}>
            <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50 focus:bg-brand-50 focus:outline-none" onClick={() => pick(c)}>
              <span className="truncate font-medium">{c.name}</span>
              {c.phone && <span className="shrink-0 text-xs text-slate-500">{c.phone}</span>}
            </button>
          </li>
        ))}
      </ul>
      {/* Keeps the form from submitting without a customer (the native "required" message). */}
      <input tabIndex={-1} aria-hidden required value={value} onChange={() => undefined} className="pointer-events-none h-0 w-full opacity-0" />
    </div>
  );
}
