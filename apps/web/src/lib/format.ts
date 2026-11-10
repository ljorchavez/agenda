import { useTranslation } from 'react-i18next';
import { enUS, es } from 'date-fns/locale';
import i18n from '../i18n';

export const dateLocale = () => (i18n.language.startsWith('en') ? enUS : es);
export const intlLocale = () => (i18n.language.startsWith('en') ? 'en-US' : 'es-MX');
/** Same as intlLocale, as a hook so components re-render on language change. */
export function useIntlLocale() {
  const { i18n: i } = useTranslation();
  return i.language.startsWith('en') ? 'en-US' : 'es-MX';
}

export function money(cents: number, currency = 'MXN'): string {
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function dateTime(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(iso));
}

export function dateOnly(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeZone: tz }).format(
    new Date(iso),
  );
}

export function timeOnly(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { timeStyle: 'short', timeZone: tz }).format(
    new Date(iso),
  );
}

export function percent(v: number): string {
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v);
}

/** Pesos (string from an input) -> cents */
export const toCents = (pesos: string | number) => Math.round(Number(pesos) * 100);

/** Value for <input type="datetime-local"> from a Date */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-slate-50 text-slate-700 border-slate-300 border-dashed',
  confirmed: 'bg-sky-100 text-sky-800 border-sky-200',
  completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200 line-through',
  no_show: 'bg-rose-100 text-rose-800 border-rose-200',
};
