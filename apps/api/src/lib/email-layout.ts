import { escapeHtml } from './email.js';

/**
 * One branded, table-based layout for every email the app sends (works in Gmail, Outlook,
 * Apple Mail and phones). Content is plain strings: everything is escaped here.
 */
export type EmailTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export interface EmailBlock {
  /** Hidden preview line shown next to the subject in the inbox. */
  preheader?: string;
  /** Who it's from: Lugali, or the business (then "Enviado con Lugali" goes in the footer). */
  brand?: { name: string; byLugali?: boolean };
  badge?: { text: string; tone: EmailTone };
  title: string;
  /** Paragraphs before the details. */
  intro?: string[];
  /** Big centred value: an amount, a 6-digit code… */
  highlight?: { label?: string; value: string; caption?: string; mono?: boolean };
  /** Label / value rows in a soft card. */
  details?: { label: string; value: string; strong?: boolean }[];
  detailsStruck?: boolean;
  button?: { label: string; href: string };
  secondary?: { label: string; href: string };
  /** Paragraphs after the button. */
  outro?: string[];
  /** Small grey print at the bottom. */
  footnote?: string;
  lang?: 'es' | 'en';
}

const TONES: Record<EmailTone, { bg: string; fg: string; dot: string }> = {
  success: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  info: { bg: '#f0fdfa', fg: '#0f766e', dot: '#14b8a6' },
  warning: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  danger: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
  neutral: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BRAND = '#0f766e';

export function appBaseUrl(): string {
  return (process.env.APP_URL ?? 'https://www.lugali.com').replace(/\/$/, '');
}

const e = escapeHtml;
const p = (s: string, extra = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:#334155;${extra}">${e(s)}</p>`;

export function renderEmail(b: EmailBlock): string {
  const base = appBaseUrl();
  const brandName = b.brand?.name ?? 'Lugali';
  const isLugali = !b.brand || b.brand.name === 'Lugali';
  const tone = b.badge ? TONES[b.badge.tone] : null;

  const header = isLugali
    ? `<img src="${base}/icons/icon-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px">`
    : `<div style="width:36px;height:36px;border-radius:9px;background:${BRAND};color:#ffffff;font:700 17px/36px ${FONT};text-align:center">${e(brandName.trim().charAt(0).toUpperCase())}</div>`;

  const badge = b.badge && tone
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td style="background:${tone.bg};color:${tone.fg};border-radius:999px;padding:5px 12px;font:600 12px/16px ${FONT}"><span style="color:${tone.dot}">&#9679;</span>&nbsp; ${e(b.badge.text)}</td></tr></table>`
    : '';

  const highlight = b.highlight
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td align="center" style="background:#f0fdfa;border:1px solid #ccfbf1;border-radius:14px;padding:18px 16px">
${b.highlight.label ? `<div style="font:500 13px/18px ${FONT};color:#0f766e;margin-bottom:4px">${e(b.highlight.label)}</div>` : ''}
<div style="font:700 ${b.highlight.mono ? '32px/40px ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px' : `30px/38px ${FONT}`};color:#0f172a">${e(b.highlight.value)}</div>
${b.highlight.caption ? `<div style="font:400 13px/18px ${FONT};color:#64748b;margin-top:4px">${e(b.highlight.caption)}</div>` : ''}
</td></tr></table>`
    : '';

  const details = b.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px"><tr><td style="padding:6px 18px">
${b.details
  .map(
    (d, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"${i ? ' style="border-top:1px solid #e2e8f0"' : ''}><tr>
<td style="padding:11px 0;font:400 13px/20px ${FONT};color:#64748b;vertical-align:top;width:38%">${e(d.label)}</td>
<td style="padding:11px 0;font:${d.strong ? 600 : 500} 14px/20px ${FONT};color:${b.detailsStruck ? '#94a3b8' : '#0f172a'};text-align:right;vertical-align:top${b.detailsStruck ? ';text-decoration:line-through' : ''}">${e(d.value)}</td>
</tr></table>`,
  )
  .join('\n')}
</td></tr></table>`
    : '';

  const button = b.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px"><tr><td style="border-radius:10px;background:${BRAND}"><a href="${e(b.button.href)}" style="display:inline-block;padding:13px 24px;font:600 15px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${e(b.button.label)}</a></td></tr></table>`
    : '';
  const secondary = b.secondary
    ? `<p style="margin:0 0 18px;font:500 14px/20px ${FONT}"><a href="${e(b.secondary.href)}" style="color:${BRAND};text-decoration:underline">${e(b.secondary.label)}</a></p>`
    : '';

  const en = b.lang === 'en';
  const footer = isLugali
    ? `Lugali · ${en ? 'Bookings, payments and clients for your business' : 'Agenda, cobros y clientes para tu negocio'}<br><a href="${base}" style="color:#94a3b8">lugali.com</a>`
    : `${e(brandName)}<br>${en ? 'Sent with' : 'Enviado con'} <a href="${base}" style="color:#94a3b8">Lugali</a>`;

  return `<!DOCTYPE html>
<html lang="${en ? 'en' : 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(b.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%">
${b.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${e(b.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 6px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle">${header}</td><td style="vertical-align:middle;padding-left:10px;font:700 17px/22px ${FONT};color:#0f172a">${e(brandName)}</td></tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:18px;border:1px solid #e2e8f0;overflow:hidden">
<div style="height:4px;background:${BRAND};line-height:4px;font-size:0">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 28px 14px">
${badge}
<h1 style="margin:0 0 14px;font:700 22px/30px ${FONT};color:#0f172a">${e(b.title)}</h1>
${(b.intro ?? []).map((s) => p(s)).join('\n')}
${highlight}
${details}
${button}
${secondary}
${(b.outro ?? []).map((s) => p(s, 'font-size:14px;color:#475569')).join('\n')}
</td></tr></table>
</td></tr>
<tr><td style="padding:18px 10px 0;text-align:center;font:400 12px/18px ${FONT};color:#94a3b8">
${b.footnote ? `${e(b.footnote)}<br><br>` : ''}${footer}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
