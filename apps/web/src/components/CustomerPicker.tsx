import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomerWithStats } from '@agenda/shared';
import { useCustomers } from '../lib/queries';

export type NewCustomer = { name: string; phone: string };

/**
 * Search box + tappable results (works the same on phones and desktop). Once picked, the customer
 * shows as a card with "Cambiar". Enter picks the first result.
 * When the name typed isn't on the list, it becomes a new customer right there (asks for the phone),
 * no need to start over with "+ Cliente nuevo".
 */
export function CustomerPicker({
  value,
  onChange,
  forBooking,
  newCustomer,
  onNewCustomer,
}: {
  value: string;
  onChange: (id: string) => void;
  forBooking: boolean;
  newCustomer?: NewCustomer | null;
  onNewCustomer?: (c: NewCustomer | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(newCustomer?.name ?? '');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<CustomerWithStats | null>(null);
  // "Register as new" chosen by hand while there were similar names on the list
  const [forceNew, setForceNew] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);
  const customers = useCustomers(debounced, 'name', forBooking);
  const items = (customers.data?.items ?? []).slice(0, 6);
  const typed = search.trim();
  const settled = debounced === typed && !customers.isFetching;
  const canCreate = Boolean(onNewCustomer) && typed.length >= 2;
  const isNew = canCreate && (forceNew || (settled && items.length === 0));

  // Tell the form whether it's creating someone, and with which name.
  useEffect(() => {
    if (!onNewCustomer) return;
    if (isNew) onNewCustomer({ name: typed, phone: newCustomer?.phone ?? '' });
    else if (newCustomer) onNewCustomer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, typed]);

  const pick = (c: CustomerWithStats) => {
    setPicked(c);
    setForceNew(false);
    onNewCustomer?.(null);
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
        placeholder={onNewCustomer ? t('agenda.customerSearchOrNew') : t('customers.searchPlaceholder')}
        className="input"
        value={search}
        aria-label={t('agenda.customer')}
        onChange={(e) => {
          setSearch(e.target.value);
          setForceNew(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items[0] && !isNew) pick(items[0]);
          }
        }}
      />
      {isNew ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="new-customer">
          <p className="text-sm text-amber-900">
            <span aria-hidden>✚ </span>
            {forceNew ? t('agenda.registeringNew', { name: typed }) : t('agenda.notFoundRegistering', { name: typed })}
          </p>
          <input
            type="tel"
            required
            autoComplete="off"
            className="input mt-2 bg-white"
            placeholder={t('agenda.newCustomerPhone')}
            aria-label={t('customers.phone')}
            value={newCustomer?.phone ?? ''}
            onChange={(e) => onNewCustomer!({ name: typed, phone: e.target.value })}
          />
          {forceNew && (
            <button type="button" className="mt-2 text-xs font-medium text-slate-600 hover:underline" onClick={() => setForceNew(false)}>
              {t('agenda.backToList')}
            </button>
          )}
        </div>
      ) : (
        <ul className="mt-2 max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" role="listbox" aria-label={t('agenda.customer')}>
          {customers.isLoading && <li className="px-3 py-2 text-sm text-slate-500">{t('common.loading')}</li>}
          {!customers.isLoading && items.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{onNewCustomer ? t('agenda.typeToCreate') : t('agenda.noCustomerFound')}</li>}
          {items.map((c) => (
            <li key={c.id} role="option" aria-selected={false}>
              <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50 focus:bg-brand-50 focus:outline-none" onClick={() => pick(c)}>
                <span className="truncate font-medium">{c.name}</span>
                {c.phone && <span className="shrink-0 text-xs text-slate-500">{c.phone}</span>}
              </button>
            </li>
          ))}
          {canCreate && items.length > 0 && (
            <li>
              <button type="button" className="w-full px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-50" onClick={() => setForceNew(true)}>
                + {t('agenda.registerAsNew', { name: typed })}
              </button>
            </li>
          )}
        </ul>
      )}
      {/* Keeps the form from submitting without a customer (the native "required" message). */}
      {!isNew && <input tabIndex={-1} aria-hidden required value={value} onChange={() => undefined} className="pointer-events-none h-0 w-full opacity-0" />}
    </div>
  );
}
