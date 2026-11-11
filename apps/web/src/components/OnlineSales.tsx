import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesSettings } from '@agenda/shared';
import { useAuth } from '../lib/auth';
import { money, toCents } from '../lib/format';
import { useFeature } from './Sales';

/** Configuración → Paquetes: sell packages, memberships and gift cards on the booking page. */
export function OnlineSalesSection({ value, onChange, disabled }: { value: SalesSettings; onChange: (v: SalesSettings) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const enabled = useFeature('packages');
  const mp = tenant?.mercadoPago.connected ?? false;
  const [amount, setAmount] = useState('');
  if (!enabled) return null;
  const add = () => {
    const c = toCents(amount || '0');
    if (c < 10_000 || value.giftCardAmounts.includes(c) || value.giftCardAmounts.length >= 6) return;
    onChange({ ...value, giftCardAmounts: [...value.giftCardAmounts, c].sort((a, b) => a - b) });
    setAmount('');
  };
  return (
    <section className="card space-y-3" data-testid="online-sales">
      <div>
        <h2 className="font-semibold">🛒 {t('shop.settingsTitle')}</h2>
        <p className="text-sm text-slate-500">{t('shop.settingsHelp')}</p>
      </div>
      {!mp && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('shop.needsMp')} <a href="/settings?tab=payments" className="font-medium underline">{t('shop.connectMp')}</a>
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={disabled} checked={value.online} onChange={(e) => onChange({ ...value, online: e.target.checked })} data-testid="sell-online" />
        {t('shop.sellOnline')}
      </label>
      {value.online && (
        <div>
          <div className="label">{t('shop.giftAmounts')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {value.giftCardAmounts.map((a) => (
              <span key={a} className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs">
                {money(a)}
                {!disabled && (
                  <button type="button" aria-label={t('common.remove')} className="text-slate-400 hover:text-rose-700" onClick={() => onChange({ ...value, giftCardAmounts: value.giftCardAmounts.filter((x) => x !== a) })}>✕</button>
                )}
              </span>
            ))}
            {!disabled && value.giftCardAmounts.length < 6 && (
              <span className="flex items-center gap-1">
                <input type="number" min={100} step={50} className="input !w-24 !py-1" placeholder="$" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={t('shop.newAmount')} />
                <button type="button" className="btn-secondary !py-1" onClick={add}>+</button>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">{t('shop.giftAmountsHelp')}</p>
        </div>
      )}
    </section>
  );
}
