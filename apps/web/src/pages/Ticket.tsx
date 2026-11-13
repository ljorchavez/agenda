import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { SaleTicketDto } from '@agenda/shared';
import { api } from '../lib/api';
import { findPendingAnywhere, loadHeader } from '../lib/offlinePos';
import { money } from '../lib/format';
import { ErrorText, Loading } from '../components/ui';

/** Paper width of the ticket printer on this device (58 mm is the common small one). */
const WIDTH_KEY = 'agenda.ticketWidth';
export const ticketWidth = (): 58 | 80 => {
  try {
    return localStorage.getItem(WIDTH_KEY) === '80' ? 80 : 58;
  } catch {
    return 58;
  }
};

/** Opens a sale's ticket in a new window (optionally printing it right away). */
export function openTicket(saleId: string, opts: { print?: boolean; changeCents?: number; win?: Window | null; local?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (opts.print) qs.set('print', '1');
  if (opts.changeCents) qs.set('change', String(opts.changeCents));
  const query = qs.toString();
  const url = `/ticket/${opts.local ? 'local/' : ''}${saleId}${query ? `?${query}` : ''}`;
  if (opts.win) opts.win.location.href = url;
  else window.open(url, '_blank');
}

/** Ticket for a thermal printer (58/80 mm), printed with the browser's print dialog. */
export function TicketPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api<SaleTicketDto>(`/sales/${id}/ticket`) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <div className="p-4"><ErrorText error={q.error} /></div>;
  return <TicketView data={q.data} />;
}

/** Ticket of a sale charged without internet: printed from this device's copy. */
export function LocalTicketPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const found = findPendingAnywhere(id);
  // Already uploaded: the real ticket, with its number
  if (found?.saleId && !found.sale) {
    window.location.replace(`/ticket/${found.saleId}?${params.toString()}`);
    return <Loading />;
  }
  const p = found?.sale;
  const header = p && found ? loadHeader(found.tenantId, p.locationId) : null;
  if (!p || !found) return <div className="p-4 text-sm text-slate-600">{t('pos.offline.ticketMissing')}</div>;
  const data: SaleTicketDto = {
    business: header?.business ?? { name: '', legalName: null, rfc: null, address: null, phone: null },
    locationName: header?.locationName ?? null,
    multiLocation: header?.multiLocation ?? false,
    timezone: header?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    invoicing: header?.invoicing ?? false,
    sale: {
      id: p.clientId, number: 0, locationId: p.locationId, locationName: header?.locationName ?? null, customerId: null, customerName: p.customerName,
      payerCustomerId: null, items: p.items.map((i) => ({ ...i, productId: null, iva: '16', satKey: null })), totalCents: p.totalCents,
      payments: p.payments.map((x, i) => ({ id: String(i), ...x })), status: 'paid', notes: null, createdByName: p.createdByName, createdAt: p.soldAt,
      offline: true, invoice: null,
    },
  };
  return <TicketView data={data} provisional={p.localNo} />;
}

function TicketView({ data, provisional }: { data: SaleTicketDto; provisional?: string }) {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const [width, setWidth] = useState<58 | 80>(ticketWidth);
  const printed = useRef(false);
  const q = { data };
  const change = Number(params.get('change') ?? 0);

  useEffect(() => {
    if (q.data && params.get('print') === '1' && !printed.current) {
      printed.current = true;
      // Let the layout settle before opening the dialog
      setTimeout(() => window.print(), 300);
    }
  }, [q.data, params]);

  const pick = (w: 58 | 80) => {
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
  };

  const { business: b, sale: s } = q.data;
  const when = new Intl.DateTimeFormat(i18n.language.startsWith('en') ? 'en-US' : 'es-MX', {
    timeZone: q.data.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(s.createdAt));
  const Row = ({ left, right, bold }: { left: string; right: string; bold?: boolean }) => (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
      <span className="min-w-0 break-words">{left}</span>
      <span className="shrink-0">{right}</span>
    </div>
  );
  const hr = <div className="my-1 border-t border-dashed border-black" />;

  return (
    <div className="min-h-screen bg-slate-100 print:bg-white">
      <style>{`@media print { @page { size: ${width}mm auto; margin: 0; } html, body { background: #fff; } }`}</style>
      <div className="no-print flex flex-wrap items-center justify-center gap-2 border-b border-slate-200 bg-white p-3 text-sm print:hidden">
        <span className="text-slate-600">{t('ticket.paper')}</span>
        {([58, 80] as const).map((w) => (
          <button key={w} type="button" className={width === w ? 'btn-primary !py-1' : 'btn-secondary !py-1'} onClick={() => pick(w)}>{w} mm</button>
        ))}
        <button type="button" className="btn-primary !py-1" onClick={() => window.print()} data-testid="ticket-print">🖨️ {t('ticket.print')}</button>
        <button type="button" className="btn-secondary !py-1" onClick={() => window.close()}>{t('common.close')}</button>
      </div>
      <div
        className="mx-auto my-4 bg-white px-[3mm] py-[2mm] font-mono text-[11px] leading-snug text-black shadow print:my-0 print:shadow-none"
        style={{ width: `${width}mm` }}
        data-testid="ticket"
      >
        <div className="text-center">
          <div className="text-[13px] font-bold">{b.name}</div>
          {b.legalName && b.legalName.toUpperCase() !== b.name.toUpperCase() && <div>{b.legalName}</div>}
          {b.rfc && <div>RFC: {b.rfc}</div>}
          {b.address && <div>{b.address}</div>}
          {b.phone && <div>Tel. {b.phone}</div>}
          {q.data.multiLocation && q.data.locationName && <div>{t('ticket.location')}: {q.data.locationName}</div>}
        </div>
        {hr}
        <Row left={provisional ? `${t('ticket.provisional')} ${provisional}` : `${t('ticket.sale')} #${s.number}`} right={when} />
        {provisional && <div>{t('ticket.offlineNote')}</div>}
        {s.createdByName && <div>{t('ticket.servedBy')}: {s.createdByName}</div>}
        {s.customerName && <div>{t('ticket.customer')}: {s.customerName}</div>}
        {s.status === 'canceled' && <div className="my-1 text-center text-[13px] font-bold">*** {t('ticket.canceled')} ***</div>}
        {hr}
        {s.items.map((i, k) => (
          <div key={k} className="mb-0.5">
            <Row left={`${i.qty} x ${i.name}`} right={money(i.totalCents)} />
            {i.qty > 1 && <div className="pl-3">{money(i.unitCents)} {t('ticket.each')}</div>}
          </div>
        ))}
        {hr}
        <Row left={t('ticket.total')} right={money(s.totalCents)} bold />
        {s.payments.map((p) => <Row key={p.id} left={t(`methods.${p.method}`)} right={money(p.amountCents)} />)}
        {change > 0 && <Row left={t('ticket.change')} right={money(change)} />}
        {hr}
        <div className="text-center">
          <div>{t('ticket.vatIncluded')}</div>
          <div>{t('ticket.notFiscal')}</div>
          {q.data.invoicing && <div>{t('ticket.askInvoice')}</div>}
          <div className="mt-1 font-bold">{t('ticket.thanks')}</div>
        </div>
      </div>
    </div>
  );
}
