import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { addMonths, format, startOfMonth } from 'date-fns';
import type { PaymentDto } from '@agenda/shared';
import { Empty, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money } from '../lib/format';

export function PaymentsPage() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const to = addMonths(month, 1);

  const { data, isLoading } = useQuery({
    queryKey: ['payments', month.toISOString()],
    queryFn: () =>
      api<PaymentDto[]>(`/payments?from=${encodeURIComponent(month.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  });

  const totals = useMemo(() => {
    const paid = (data ?? []).filter((p) => p.status === 'paid').reduce((s, p) => s + p.amountCents, 0);
    const pending = (data ?? []).filter((p) => p.status === 'pending').reduce((s, p) => s + p.amountCents, 0);
    return { paid, pending };
  }, [data]);

  return (
    <>
      <PageHeader
        title={t('payments.title')}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
            <span className="self-center px-2 text-sm font-medium capitalize">{format(month, 'LLLL yyyy', { locale: dateLocale() })}</span>
            <button className="btn-secondary" onClick={() => setMonth(addMonths(month, 1))}>›</button>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:max-w-md">
        <div className="card"><div className="text-sm text-slate-500">{t('payments.paidTotal')}</div><div className="text-xl font-semibold text-emerald-700">{money(totals.paid)}</div></div>
        <div className="card"><div className="text-sm text-slate-500">{t('payments.pendingTotal')}</div><div className="text-xl font-semibold text-amber-700">{money(totals.pending)}</div></div>
      </div>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>{t('payments.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('payments.date')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.customer')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.method')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.status')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('payments.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-4 py-3">{dateTime(p.paidAt ?? p.createdAt)}</td>
                  <td className="px-4 py-3"><Link className="hover:text-brand-700" to={`/customers/${p.customerId}`}>{p.customerName}</Link></td>
                  <td className="px-4 py-3">{t(`methods.${p.method}`)}</td>
                  <td className="px-4 py-3">
                    {t(`paymentStatus.${p.status}`)}
                    {p.status === 'pending' && p.checkoutUrl && (
                      <a className="ml-2 text-brand-700 hover:underline" href={p.checkoutUrl} target="_blank" rel="noreferrer">link</a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">{money(p.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
