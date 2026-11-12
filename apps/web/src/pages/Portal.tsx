import { Captcha } from '../components/Captcha';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isHealthType, type PortalDto, type PrescriptionCheckDto } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ClinicalNoteView, RxQr } from '../components/ClinicalRecord';
import { ClinicalFieldValue } from '../components/ClinicalFields';
import { ErrorText, Loading, StatusBadge } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateOnly, dateTime } from '../lib/format';

const storeKey = (slug: string) => `agenda.portal.${slug}`;
const readToken = (slug: string) => {
  try {
    return localStorage.getItem(storeKey(slug));
  } catch {
    return null;
  }
};

async function portalFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'x-portal-token': token } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? 'error', body?.message ?? 'Error');
  return body as T;
}

/**
 * Patient (or customer) portal: /p/:slug. They ask for a link by email; with it they see their
 * appointments (change or cancel) and, in health businesses, the prescriptions, documents and
 * studies their practitioner shared.
 */
export function PortalPage() {
  const { slug = '' } = useParams();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [token, setToken] = useState<string | null>(() => params.get('t') ?? readToken(slug));
  useEffect(() => {
    const fromLink = params.get('t');
    if (!fromLink) return;
    try {
      localStorage.setItem(storeKey(slug), fromLink);
    } catch {
      /* private mode: keep it in memory */
    }
    params.delete('t');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const q = useQuery({ queryKey: ['portal', slug, token], queryFn: () => portalFetch<PortalDto>('/public/portal', token!), enabled: Boolean(token), retry: false });
  const keep = (tok: string) => {
    try {
      localStorage.setItem(storeKey(slug), tok);
    } catch {
      /* private mode: memory only */
    }
  };
  // Sliding session: keep the fresh token the server hands out
  useEffect(() => {
    if (q.data?.renewedToken) keep(q.data.renewedToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.renewedToken]);
  const signOut = () => {
    try {
      localStorage.removeItem(storeKey(slug));
    } catch {
      /* ignore */
    }
    setToken(null);
  };
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) signOut();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.error]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{q.data?.business.name ?? t('portal.title')}</h1>
            <p className="text-slate-600">{t('portal.subtitle')}</p>
          </div>
          <LanguageSwitch />
        </div>
        {!token ? <AskLink slug={slug} onToken={(tok) => { keep(tok); setToken(tok); }} /> : q.isLoading ? <Loading /> : q.data ? <PortalBody data={q.data} onSignOut={signOut} /> : <ErrorText error={q.error} ns="portal" />}
      </div>
    </div>
  );
}

function AskLink({ slug, onToken }: { slug: string; onToken: (token: string) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const ask = useMutation({ mutationFn: () => api(`/public/${slug}/portal/link`, { method: 'POST', body: { email } }) });
  const enter = useMutation({
    mutationFn: () => api<{ token: string }>(`/public/${slug}/portal/code`, { method: 'POST', body: { email, code } }),
    onSuccess: (r) => onToken(r.token),
  });
  if (ask.isSuccess) {
    return (
      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); enter.mutate(); }} data-testid="portal-code">
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{t('portal.sent')}</p>
        <label className="block text-sm">
          <span className="label">{t('portal.code')}</span>
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className="input text-center font-mono text-2xl tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label={t('portal.code')} />
        </label>
        <ErrorText error={enter.error} ns="portal" />
        <button className="btn-primary w-full" disabled={enter.isPending || code.length !== 6}>{t('portal.enter')}</button>
        <button type="button" className="w-full text-sm text-slate-500 hover:underline" onClick={() => { ask.reset(); setCode(''); }}>{t('portal.otherEmail')}</button>
      </form>
    );
  }
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); ask.mutate(); }} data-testid="portal-ask">
      <p className="text-sm text-slate-600">{t('portal.askHelp')}</p>
      <input type="email" required className="input" placeholder={t('customers.email')} aria-label={t('customers.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
      <Captcha />
      <ErrorText error={ask.error} ns="portal" />
      <button className="btn-primary w-full" disabled={ask.isPending}>{t('portal.sendLink')}</button>
      <p className="text-center text-sm"><Link to={`/b/${slug}`} className="text-brand-700 hover:underline">{t('portal.book')}</Link></p>
    </form>
  );
}

function PortalBody({ data, onSignOut }: { data: PortalDto; onSignOut: () => void }) {
  const { t } = useTranslation();
  const now = Date.now();
  const upcoming = data.appointments.filter((a) => new Date(a.startsAt).getTime() >= now && a.status !== 'cancelled').reverse();
  const past = data.appointments.filter((a) => !upcoming.includes(a)).slice(0, 10);
  const health = isHealthType(data.business.businessType);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="card flex items-center justify-between gap-2">
        <span>{t('portal.hello', { name: data.patient.name.split(' ')[0] })}</span>
        <span className="flex gap-3 text-sm">
          <Link to={`/b/${data.business.slug}`} className="text-brand-700 hover:underline">{t('portal.book')}</Link>
          <button type="button" className="text-slate-500 hover:underline" onClick={onSignOut}>{t('portal.signOut')}</button>
        </span>
      </div>
      <section className="card space-y-2" data-testid="portal-appointments">
        <h2 className="font-semibold">{t('portal.upcoming')}</h2>
        {upcoming.length === 0 && <p className="text-sm text-slate-500">{t('portal.noUpcoming')}</p>}
        {upcoming.map((a) => (
          <Link key={a.id} to={a.managePath} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:border-brand-400">
            <span>
              <b>{a.serviceName}</b>
              {a.resourceName && <span className="text-slate-500"> · {a.resourceName}</span>}
              <span className="block text-slate-600">{dateTime(a.startsAt)}</span>
            </span>
            <span className="text-xs text-brand-700">{t('portal.manage')} →</span>
          </Link>
        ))}
        {past.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-500">{t('portal.past')}</summary>
            <ul className="mt-2 space-y-1">
              {past.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-slate-600">
                  <span>{a.serviceName} · {dateTime(a.startsAt)}</span>
                  <StatusBadge status={a.status as never} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      {health && (
        <section className="card space-y-2" data-testid="portal-documents">
          <h2 className="font-semibold">{t('portal.documents')}</h2>
          {data.documents.length === 0 && data.studies.length === 0 && <p className="text-sm text-slate-500">{t('portal.noDocuments')}</p>}
          {data.documents.map((n) => (
            <div key={n.id} className="rounded-lg border border-slate-200 text-sm">
              <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setOpen(open === n.id ? null : n.id)} aria-expanded={open === n.id}>
                <span><b>{n.title}</b><span className="block text-xs text-slate-500">{dateOnly(n.signedAt ?? n.createdAt)} · {n.author?.name}</span></span>
                <span className="text-xs text-brand-700">{open === n.id ? '▲' : '▼'}</span>
              </button>
              {open === n.id && (
                <div className="space-y-2 border-t border-slate-100 px-3 py-3">
                  <ClinicalNoteView note={n} businessType={data.business.businessType} />
                  {n.verifyPath && <a href={n.verifyPath} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">🖨️ {t('portal.printRx')}</a>}
                </div>
              )}
            </div>
          ))}
          {data.studies.map((s) => (
            <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:border-brand-400">
              <span>{s.contentType === 'application/pdf' ? '📄' : '🖼️'} <b>{s.title ?? t(`clinical.studyKinds.${s.kind}`)}</b> <span className="text-xs text-slate-500">· {dateOnly(s.createdAt)}</span></span>
              <span className="text-xs text-brand-700">{t('portal.open')}</span>
            </a>
          ))}
        </section>
      )}
      <p className="text-center text-xs text-slate-400">{[data.business.address, data.business.phone].filter(Boolean).join(' · ')}</p>
    </>
  );
}

/** Public check of a signed prescription (the QR on the printed one): /receta/:token */
export function PrescriptionPage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['rx', token], queryFn: () => api<PrescriptionCheckDto>(`/public/prescriptions/${encodeURIComponent(token)}`), retry: false });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <div className="flex min-h-screen items-center justify-center p-6 text-center text-slate-600">{t('rx.notFound')}</div>;
  const d = q.data;
  const meds = { id: 'medicamentos', label: t('rx.medications'), type: 'medications' as const };
  return (
    <div className="mx-auto max-w-2xl bg-white p-6 text-slate-900 print:p-0" data-testid="rx-page">
      <div className="mb-3 flex justify-between gap-2 print:hidden">
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800">✓ {t('rx.authentic')}</span>
        <button type="button" className="btn-primary !py-1.5 text-sm" onClick={() => window.print()}>🖨️ {t('clinical.printPdf')}</button>
      </div>
      <header className="border-b-2 border-brand-700 pb-3">
        <div className="text-xl font-bold">{d.clinic.name}</div>
        {d.clinic.legalName && <div className="text-xs">{d.clinic.legalName}</div>}
        <div className="text-xs text-slate-600">{[d.clinic.address, d.clinic.phone].filter(Boolean).join(' · ')}</div>
        {d.clinic.healthLicense && <div className="text-xs text-slate-600">{t('clinical.healthLicense')}: {d.clinic.healthLicense}</div>}
      </header>
      <div className="my-3 text-sm">
        <div><b>{t('clinical.patient')}:</b> {d.patient.name}{d.patient.age != null ? ` · ${t('clinical.age', { count: d.patient.age })}` : ''}</div>
        <div><b>{t('rx.date')}:</b> {dateTime(d.signedAt)}</div>
        {typeof d.content.diagnostico === 'string' && d.content.diagnostico && <div><b>{t('rx.diagnosis')}:</b> {d.content.diagnostico}</div>}
      </div>
      <h2 className="mb-2 text-lg font-semibold">℞ {t('rx.title')}</h2>
      <ClinicalFieldValue field={meds} value={d.content.medicamentos} />
      {typeof d.content.indicaciones === 'string' && d.content.indicaciones && <p className="mt-3 whitespace-pre-wrap text-sm">{d.content.indicaciones}</p>}
      <div className="mt-10 w-72 border-t border-slate-500 pt-1 text-center text-xs">
        <b>{d.doctor.name}</b>
        {d.doctor.specialty && <div>{d.doctor.specialty}{d.doctor.specialtyLicense ? ` · ${t('clinical.specialtyLicense')} ${d.doctor.specialtyLicense}` : ''}</div>}
        {d.doctor.license && <div>{t('clinical.license')} {d.doctor.license}{d.doctor.institution ? ` · ${d.doctor.institution}` : ''}</div>}
        <div className="text-slate-500">{t('clinical.electronicSignature')} · {d.contentHash.slice(0, 16)}</div>
      </div>
      <RxQr path={window.location.pathname} />
      <p className="mt-4 text-[10px] text-slate-400">{t('rx.footer')}</p>
    </div>
  );
}
