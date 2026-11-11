import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CLINICAL_TEMPLATES,
  ageOn,
  clinicalTemplatesFor,
  missingRequired,
  type ClinicalContent,
  type ClinicalLogDto,
  type ClinicalNoteDto,
  type ClinicalRecordDto,
  type ClinicalTemplate,
} from '@agenda/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime } from '../lib/format';
import { SaveStatus, useAutoSave } from '../lib/autosave';
import { ClinicalFieldInput, ClinicalFieldValue, OdontogramInput } from './ClinicalFields';
import { ErrorText, Modal } from './ui';
import { UpgradeNote, useFeature } from './Sales';

export const useClinical = (customerId: string, enabled = true) =>
  useQuery({
    queryKey: ['clinical', customerId],
    queryFn: () => api<ClinicalRecordDto>(`/customers/${customerId}/clinical`),
    enabled,
    retry: false,
  });

/** Patient data the record needs (NOM-004 5.2): saved by itself. */
function PatientData({ record, customerId }: { record: ClinicalRecordDto; customerId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const p = record.patient;
  const [v, setV] = useState({ birthday: p.birthday ?? '', sex: p.sex ?? '', address: p.address ?? '', curp: p.curp ?? '' });
  const save = useMutation({
    mutationFn: () =>
      api(`/customers/${customerId}`, {
        method: 'PUT',
        body: { name: p.name, birthday: v.birthday || null, sex: v.sex || null, address: v.address || null, curp: v.curp || null },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', customerId] });
    },
  });
  const curpOk = !v.curp || /^[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z0-9]\d$/.test(v.curp);
  const state = useAutoSave(v, () => save.mutateAsync(), { valid: curpOk });
  const age = ageOn(v.birthday || null);
  return (
    <div className="grid gap-2 sm:grid-cols-4" data-testid="patient-data">
      <label className="block text-sm">
        <span className="label">{t('clinical.birthday')}{age != null && <span className="font-normal text-slate-500"> · {t('clinical.age', { count: age })}</span>}</span>
        <input type="date" className="input" value={v.birthday} onChange={(e) => setV({ ...v, birthday: e.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="label">{t('clinical.sex')}</span>
        <select className="input" value={v.sex} onChange={(e) => setV({ ...v, sex: e.target.value })}>
          <option value="">—</option>
          <option value="F">{t('clinical.sexF')}</option>
          <option value="M">{t('clinical.sexM')}</option>
          <option value="X">{t('clinical.sexX')}</option>
        </select>
      </label>
      <label className="block text-sm sm:col-span-2">
        <span className="label">{t('clinical.address')}</span>
        <input className="input" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
      </label>
      <label className="block text-sm sm:col-span-2">
        <span className="label">CURP <span className="font-normal text-slate-400">({t('common.optional')})</span></span>
        <input className={`input font-mono uppercase ${curpOk ? '' : '!border-rose-500'}`} maxLength={18} value={v.curp} onChange={(e) => setV({ ...v, curp: e.target.value.toUpperCase() })} />
      </label>
      <div className="flex items-end sm:col-span-2"><SaveStatus state={state} /></div>
    </div>
  );
}

/** Asks for the password: signing stamps date, time, author and cédula. */
function SignDialog({ title, onSign, onClose, pending, error }: { title: string; onSign: (password: string) => void; onClose: () => void; pending: boolean; error: unknown }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [password, setPassword] = useState('');
  return (
    <Modal open title={t('clinical.signTitle', { title })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSign(password); }} data-testid="sign-dialog">
        <p className="text-sm text-slate-600">{t('clinical.signHelp')}</p>
        <p className="rounded-lg bg-slate-50 p-2 text-sm">
          <b>{user?.name}</b>
          {user?.professional?.license ? ` · ${t('clinical.license')} ${user.professional.license}` : ` · ${t('clinical.noLicense')}`}
        </p>
        <input type="password" required autoFocus autoComplete="current-password" className="input" placeholder={t('auth.password')} aria-label={t('auth.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} ns="clinical" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={pending || !password}>✍️ {t('clinical.sign')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Fill a document. Saved as a draft by itself; "Firmar" closes it for good. */
function ClinicalEditor({ customerId, template, note, appointmentId, onClose }: { customerId: string; template: ClinicalTemplate; note?: ClinicalNoteDto; appointmentId?: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [content, setContent] = useState<ClinicalContent>(note?.content ?? {});
  const [id, setId] = useState<string | null>(note?.id ?? null);
  const [signing, setSigning] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['clinical', customerId] });
  const saveDraft = useMutation({
    mutationFn: async () => {
      if (id) return api<ClinicalNoteDto>(`/clinical-notes/${id}`, { method: 'PUT', body: { content } });
      const n = await api<ClinicalNoteDto>(`/customers/${customerId}/clinical-notes`, { method: 'POST', body: { template: template.id, appointmentId: appointmentId ?? null, content } });
      setId(n.id);
      return n;
    },
    onSuccess: refresh,
  });
  const draftState = useAutoSave(content, () => saveDraft.mutateAsync(), { delay: 1200 });
  const sign = useMutation({
    mutationFn: async (password: string) => {
      if (id) {
        await api(`/clinical-notes/${id}`, { method: 'PUT', body: { content } });
        return api<ClinicalNoteDto>(`/clinical-notes/${id}/sign`, { method: 'POST', body: { password } });
      }
      return api<ClinicalNoteDto>(`/customers/${customerId}/clinical-notes`, { method: 'POST', body: { template: template.id, appointmentId: appointmentId ?? null, content, password } });
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const missing = missingRequired(template, content);
  return (
    <Modal open wide title={template.title} onClose={onClose}>
      <div className="space-y-5" data-testid="clinical-editor">
        <p className="text-xs text-slate-500">{template.norm} · {t('clinical.draftHelp')}</p>
        {template.sections.map((s) => (
          <section key={s.id} className="space-y-3">
            {template.sections.length > 1 && <h3 className="border-b border-slate-100 pb-1 text-sm font-semibold text-brand-800">{s.title}</h3>}
            <div className="grid gap-3 sm:grid-cols-2">
              {s.fields.map((f) => (
                <div key={f.id} className={['text', 'number', 'select', 'date', 'pain'].includes(f.type) ? '' : 'sm:col-span-2'}>
                  <ClinicalFieldInput field={f} value={content[f.id]} onChange={(v) => setContent((c) => ({ ...c, [f.id]: v }))} />
                </div>
              ))}
            </div>
          </section>
        ))}
        <ErrorText error={saveDraft.error} ns="clinical" />
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-white px-1 pt-3">
          <span className="text-xs text-slate-500">
            {missing ? <span className="text-amber-700">{t('clinical.missing', { field: missing })}</span> : <SaveStatus state={draftState} />}
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{t('clinical.keepDraft')}</button>
            <button type="button" className="btn-primary" disabled={Boolean(missing)} onClick={() => setSigning(true)} data-testid="sign-button">✍️ {t('clinical.sign')}</button>
          </div>
        </div>
      </div>
      {signing && <SignDialog title={template.title} pending={sign.isPending} error={sign.error} onClose={() => setSigning(false)} onSign={(p) => sign.mutate(p)} />}
    </Modal>
  );
}

/** One document, read-only, with its signature. */
export function ClinicalNoteView({ note, amended }: { note: ClinicalNoteDto; amended?: ClinicalNoteDto[] }) {
  const { t } = useTranslation();
  const tpl = CLINICAL_TEMPLATES[note.template];
  if (!tpl) return null;
  return (
    <div className="space-y-3">
      {tpl.sections.map((s) => {
        const shown = s.fields.filter((f) => f.type === 'yesno' ? note.content[f.id] !== undefined : true);
        if (!shown.some((f) => note.content[f.id] != null && note.content[f.id] !== '')) return null;
        return (
          <section key={s.id} className="space-y-1.5 break-inside-avoid">
            {tpl.sections.length > 1 && <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{s.title}</h4>}
            {shown.map((f) => <ClinicalFieldValue key={f.id} field={f} value={note.content[f.id]} />)}
          </section>
        );
      })}
      {note.kind === 'addendum' && typeof note.content.sobre === 'string' && <p className="text-xs text-slate-500">{t('clinical.about', { what: note.content.sobre })}</p>}
      {amended?.map((a) => (
        <div key={a.id} className="rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-sm">
          <b>{t('clinical.addendum')}</b> · {dateTime(a.signedAt!)} · {a.author?.name}
          <div className="whitespace-pre-wrap">{String(a.content.texto ?? '')}</div>
        </div>
      ))}
      {note.status === 'signed' && note.author && (
        <p className="border-t border-slate-100 pt-2 text-xs text-slate-500" data-testid="signature-line">
          ✍️ {t('clinical.signedBy', { name: note.author.name, date: dateTime(note.signedAt!) })}
          {note.author.license && ` · ${t('clinical.license')} ${note.author.license}`}
          {note.author.specialty && ` · ${note.author.specialty}`}
          {note.contentHash && <span className="font-mono"> · {note.contentHash.slice(0, 12)}</span>}
        </p>
      )}
    </div>
  );
}

function AddendumDialog({ note, onClose }: { note: ClinicalNoteDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/clinical-notes/${note.id}/addendum`, { method: 'POST', body: { text, password } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clinical'] });
      onClose();
    },
  });
  return (
    <Modal open title={t('clinical.addendumTitle', { title: note.title })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <p className="text-sm text-slate-600">{t('clinical.addendumHelp')}</p>
        <textarea required minLength={2} rows={4} className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('clinical.addendum')} />
        <input type="password" required className="input" placeholder={t('auth.password')} aria-label={t('auth.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={add.error} ns="clinical" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={add.isPending}>✍️ {t('clinical.sign')}</button>
        </div>
      </form>
    </Modal>
  );
}

function AccessLog({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const log = useQuery({ queryKey: ['clinical-log', customerId], queryFn: () => api<ClinicalLogDto[]>(`/customers/${customerId}/clinical-log`), enabled: open });
  return (
    <div>
      <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(!open)} data-testid="access-log-toggle">
        🔎 {t('clinical.log')} {open ? '▲' : '▼'}
      </button>
      {open && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-slate-600" data-testid="access-log">
          {(log.data ?? []).map((l, i) => (
            <li key={i}>{dateTime(l.createdAt)} · <b>{l.userName}</b> · {t(`clinical.actions.${l.action}`)}{l.detail ? ` · ${l.detail}` : ''}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Expediente clínico of a patient (health businesses): patient data, documents by date (drafts
 * only for their author), new documents from the templates of the giro, print and bitácora.
 */
export function ClinicalRecordSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant, user } = useAuth();
  const enabled = useFeature('records');
  const rec = useClinical(customerId, enabled);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<{ template: ClinicalTemplate; note?: ClinicalNoteDto; appointmentId?: string | null } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [amending, setAmending] = useState<ClinicalNoteDto | null>(null);
  const templates = clinicalTemplatesFor(tenant?.businessType ?? '');
  const remove = useMutation({
    mutationFn: (id: string) => api(`/clinical-notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['clinical', customerId] }),
  });
  // From the appointment: /customers/:id?nota=evolution&cita=<id>
  useEffect(() => {
    const kind = params.get('nota');
    if (!kind || !rec.data) return;
    const tpl = templates.find((x) => x.kind === kind) ?? templates[1];
    if (tpl) setEditing({ template: tpl, appointmentId: params.get('cita') });
    params.delete('nota');
    params.delete('cita');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.data]);

  if (!enabled) {
    return (
      <section className="card space-y-2">
        <h2 className="font-semibold">📋 {t('clinical.title')}</h2>
        <UpgradeNote feature="records" />
      </section>
    );
  }
  if (rec.error instanceof ApiError && rec.error.status === 403) return null;
  const d = rec.data;
  const main = d?.notes.filter((n) => n.kind !== 'addendum') ?? [];
  const addenda = d?.notes.filter((n) => n.kind === 'addendum') ?? [];
  const hasHistory = main.some((n) => n.kind === 'history' && n.status === 'signed');
  const history = templates.find((x) => x.kind === 'history');
  const evolution = templates.find((x) => x.kind === 'evolution');
  return (
    <section className="card space-y-4" data-testid="clinical-record">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">📋 {t('clinical.title')}</h2>
          <p className="text-xs text-slate-500">🔒 {t('clinical.private', { norm: d?.norm ?? '' })}</p>
        </div>
        {d && (
          <Link to={`/customers/${customerId}/imprimir?doc=all`} target="_blank" className="btn-secondary !py-1.5 text-sm" data-testid="print-all">
            🖨️ {t('clinical.printAll')}
          </Link>
        )}
      </div>
      <ErrorText error={rec.error} ns="clinical" />
      {d && (
        <>
          {!user?.professional?.license && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {t('clinical.addLicense')} <Link to="/settings?tab=account" className="font-medium underline">{t('clinical.addLicenseLink')}</Link>
            </p>
          )}
          <PatientData record={d} customerId={customerId} />
          <div className="flex flex-wrap gap-2">
            {history && (
              <button type="button" className={hasHistory ? 'btn-secondary' : 'btn-primary'} onClick={() => setEditing({ template: history })} data-testid="new-history">
                + {history.title}
              </button>
            )}
            {evolution && (
              <button type="button" className={hasHistory ? 'btn-primary' : 'btn-secondary'} onClick={() => setEditing({ template: evolution })} data-testid="new-evolution">
                + {evolution.title}
              </button>
            )}
            {templates.filter((x) => x.kind !== 'history' && x.kind !== 'evolution').map((x) => (
              <button key={x.id} type="button" className="btn-secondary" onClick={() => setEditing({ template: x })} data-testid={`new-${x.id}`}>
                + {x.title}
              </button>
            ))}
          </div>
          {d.odontogram && (
            <div className="rounded-lg border border-slate-200 p-3">
              <h3 className="mb-1 text-sm font-semibold">🦷 {t('clinical.currentOdontogram')}</h3>
              <OdontogramInput value={d.odontogram} readOnly />
            </div>
          )}
          <ul className="space-y-2" data-testid="clinical-notes">
            {main.map((n) => (
              <li key={n.id} className="rounded-lg border border-slate-200 text-sm">
                <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setViewing(viewing === n.id ? null : n.id)} aria-expanded={viewing === n.id}>
                  <span>
                    <b>{n.title}</b>
                    <span className="block text-xs text-slate-500">
                      {n.appointmentAt ? `${n.serviceName ?? ''} · ${dateTime(n.appointmentAt)}` : dateTime(n.signedAt ?? n.createdAt)}
                      {n.author ? ` · ${n.author.name}` : ''}
                      {addenda.some((a) => a.amendsId === n.id) && ` · ${t('clinical.hasAddendum')}`}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${n.status === 'signed' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                    {n.status === 'signed' ? `✓ ${t('clinical.signed')}` : t('clinical.draft')}
                  </span>
                </button>
                {viewing === n.id && (
                  <div className="space-y-3 border-t border-slate-100 px-3 py-3">
                    <ClinicalNoteView note={n} amended={addenda.filter((a) => a.amendsId === n.id)} />
                    <div className="flex flex-wrap gap-3 text-xs">
                      {n.status === 'signed' ? (
                        <>
                          <Link to={`/customers/${customerId}/imprimir?doc=${n.id}`} target="_blank" className="text-brand-700 hover:underline">🖨️ {t('clinical.print')}</Link>
                          <button type="button" className="text-slate-600 hover:underline" onClick={() => setAmending(n)}>{t('clinical.addAddendum')}</button>
                        </>
                      ) : n.authorId === user?.id ? (
                        <>
                          <button type="button" className="text-brand-700 hover:underline" onClick={() => setEditing({ template: CLINICAL_TEMPLATES[n.template]!, note: n })}>{t('clinical.continue')}</button>
                          <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('clinical.deleteDraft')) && remove.mutate(n.id)}>{t('common.delete')}</button>
                        </>
                      ) : null}
                    </div>
                  </div>
                )}
              </li>
            ))}
            {main.length === 0 && <li className="text-sm text-slate-500">{t('clinical.empty')}</li>}
          </ul>
          {(user?.role === 'owner' || user?.role === 'admin') && <AccessLog customerId={customerId} />}
          <p className="text-[11px] text-slate-400">{t('clinical.retention')}</p>
        </>
      )}
      {editing && <ClinicalEditor customerId={customerId} template={editing.template} note={editing.note} appointmentId={editing.appointmentId} onClose={() => setEditing(null)} />}
      {amending && <AddendumDialog note={amending} onClose={() => setAmending(null)} />}
    </section>
  );
}

/** Printable documents with letterhead: /customers/:id/imprimir?doc=<id>|all ("Guardar como PDF"). */
export function ClinicalPrintPage({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const doc = params.get('doc') ?? 'all';
  const rec = useClinical(customerId);
  const d = rec.data;
  const signed = (d?.notes ?? []).filter((n) => n.status === 'signed');
  const notes = doc === 'all' ? [...signed].filter((n) => n.kind !== 'addendum').reverse() : signed.filter((n) => n.id === doc);
  const addenda = signed.filter((n) => n.kind === 'addendum');
  useEffect(() => {
    if (!d) return;
    void api(`/customers/${customerId}/clinical-log`, { method: 'POST', body: { action: 'print', detail: doc === 'all' ? t('clinical.fullRecord') : notes[0]?.title } }).catch(() => {});
    if (params.get('noprint') !== '1') window.setTimeout(() => window.print(), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(d)]);
  if (!d) return <div className="p-8 text-slate-500">{rec.error ? t('common.error') : t('common.loading')}</div>;
  const p = d.patient;
  const age = ageOn(p.birthday);
  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-slate-900 print:max-w-none print:p-0" data-testid="clinical-print">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <button type="button" className="btn-primary" onClick={() => window.print()}>🖨️ {t('clinical.printPdf')}</button>
      </div>
      <header className="flex items-start justify-between border-b-2 border-brand-700 pb-3">
        <div>
          <div className="text-xl font-bold">{d.clinic.name}</div>
          {d.clinic.legalName && <div className="text-xs">{d.clinic.legalName}</div>}
          <div className="text-xs text-slate-600">{[d.clinic.address, d.clinic.phone].filter(Boolean).join(' · ')}</div>
          {d.clinic.healthLicense && <div className="text-xs text-slate-600">{t('clinical.healthLicense')}: {d.clinic.healthLicense}</div>}
        </div>
        <div className="text-right text-xs text-slate-500">{d.norm}</div>
      </header>
      <section className="my-3 grid grid-cols-2 gap-x-6 gap-y-0.5 rounded border border-slate-300 p-2 text-sm">
        <div><b>{t('clinical.patient')}:</b> {p.name}</div>
        <div><b>{t('clinical.sex')}:</b> {p.sex ? t(`clinical.sex${p.sex}`) : '—'} · <b>{t('clinical.ageShort')}:</b> {age ?? '—'}</div>
        <div><b>{t('clinical.birthday')}:</b> {p.birthday ? dateOnly(p.birthday) : '—'}</div>
        <div><b>CURP:</b> {p.curp ?? '—'}</div>
        <div className="col-span-2"><b>{t('clinical.address')}:</b> {p.address ?? '—'}</div>
        <div className="col-span-2 text-xs text-slate-500">{t('clinical.recordNo')}: {p.id.slice(0, 8).toUpperCase()}</div>
      </section>
      {notes.map((n) => (
        <article key={n.id} className="mb-6 break-inside-avoid-page">
          <h2 className="text-lg font-semibold">{n.title}</h2>
          <div className="mb-2 text-xs text-slate-500">{dateTime(n.signedAt!)}{n.serviceName ? ` · ${n.serviceName}` : ''} · {CLINICAL_TEMPLATES[n.template]?.norm}</div>
          <ClinicalNoteView note={n} amended={addenda.filter((a) => a.amendsId === n.id)} />
          {n.author && (
            <div className="mt-8 w-72 border-t border-slate-500 pt-1 text-center text-xs">
              <b>{n.author.name}</b>
              {n.author.specialty && <div>{n.author.specialty}{n.author.specialtyLicense ? ` · ${t('clinical.specialtyLicense')} ${n.author.specialtyLicense}` : ''}</div>}
              {n.author.license && <div>{t('clinical.license')} {n.author.license}{n.author.institution ? ` · ${n.author.institution}` : ''}</div>}
              <div className="text-slate-500">{t('clinical.electronicSignature')}</div>
            </div>
          )}
        </article>
      ))}
      {notes.length === 0 && <p className="text-slate-500">{t('clinical.nothingToPrint')}</p>}
      <footer className="mt-6 border-t border-slate-200 pt-2 text-[10px] text-slate-500">{t('clinical.confidential')}</footer>
    </div>
  );
}
