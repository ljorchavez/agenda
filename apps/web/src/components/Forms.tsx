import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FORM_FIELD_TYPES,
  checkFormAnswers,
  type AppointmentFormDto,
  type FormAnswerDto,
  type FormAnswerValue,
  type FormDto,
  type FormField,
  type FormFieldType,
  type FormResponseDto,
  type PublicFormDto,
} from '@agenda/shared';
import { api } from '../lib/api';
import { dateOnly, dateTime } from '../lib/format';
import { useServices } from '../lib/queries';
import { ErrorText } from './ui';
import { UpgradeNote, useFeature } from './Sales';

export type FormValues = Record<string, FormAnswerValue>;

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const hasOptions = (t: FormFieldType) => t === 'choice' || t === 'multi';

/** Shows a stored answer as text. */
export function answerText(t: (k: string) => string, a: Pick<FormAnswerDto, 'type' | 'value'>) {
  const v = a.value;
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (a.type === 'yesno' || typeof v === 'boolean') return v ? t('forms.yes') : t('forms.no');
  if (Array.isArray(v)) return v.join(', ');
  if (a.type === 'date' && typeof v === 'string') return dateOnly(v);
  return String(v);
}

/** Inputs for a form's questions (filled by the team in the appointment). */
export function FormFields({ form, values, onChange, prefix }: { form: PublicFormDto; values: FormValues; onChange: (v: FormValues) => void; prefix: string }) {
  const { t } = useTranslation();
  const set = (id: string, v: FormAnswerValue) => onChange({ ...values, [id]: v });
  return (
    <fieldset className="space-y-3" data-testid={`form-${form.id}`}>
      <legend className="font-medium">📋 {form.name}</legend>
      {form.description && <p className="text-sm text-slate-500">{form.description}</p>}
      {form.fields.map((f) => {
        const id = `${prefix}-${form.id}-${f.id}`;
        const v = values[f.id];
        const label = (
          <span className="label" id={`${id}-l`}>
            {f.label}
            {f.required && <span className="text-rose-600"> *</span>}
          </span>
        );
        return (
          <div key={f.id}>
            {f.type === 'yesno' ? (
              <div role="radiogroup" aria-labelledby={`${id}-l`}>
                {label}
                <div className="flex gap-2">
                  {[true, false].map((b) => (
                    <label key={String(b)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${v === b ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}>
                      <input type="radio" name={id} checked={v === b} onChange={() => set(f.id, b)} />
                      {b ? t('forms.yes') : t('forms.no')}
                    </label>
                  ))}
                </div>
              </div>
            ) : f.type === 'choice' ? (
              <label className="block" htmlFor={id}>
                {label}
                <select id={id} className="input" value={typeof v === 'string' ? v : ''} onChange={(e) => set(f.id, e.target.value || null)}>
                  <option value="">—</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            ) : f.type === 'multi' ? (
              <div role="group" aria-labelledby={`${id}-l`}>
                {label}
                <div className="flex flex-wrap gap-2">
                  {f.options.map((o) => {
                    const arr = Array.isArray(v) ? v : [];
                    return (
                      <label key={o} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-sm">
                        <input type="checkbox" checked={arr.includes(o)} onChange={(e) => set(f.id, e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} />
                        {o}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <label className="block" htmlFor={id}>
                {label}
                {f.type === 'longtext' ? (
                  <textarea id={id} rows={3} className="input" maxLength={4000} value={typeof v === 'string' ? v : ''} onChange={(e) => set(f.id, e.target.value)} />
                ) : (
                  <input
                    id={id}
                    className="input"
                   
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                    step="any"
                    maxLength={f.type === 'text' ? 500 : undefined}
                    value={v == null ? '' : String(v)}
                    onChange={(e) => set(f.id, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                  />
                )}
              </label>
            )}
            {f.help && <p className="mt-0.5 text-xs text-slate-500">{f.help}</p>}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Error code of the first form with a missing/invalid answer, or null. */
export const formsError = (forms: PublicFormDto[], values: Record<string, FormValues>) => {
  for (const f of forms) {
    const err = checkFormAnswers(f.fields, values[f.id] ?? {});
    if (err) return err;
  }
  return null;
};

/** Pre-fills inputs from a saved response (answers keep their field id). */
export const valuesFrom = (r: FormResponseDto | null): FormValues => {
  const out: FormValues = {};
  for (const a of r?.answers ?? []) if (a.fieldId) out[a.fieldId] = a.value;
  return out;
};

/** Answered questionnaires in the client record. */
export function ResponsesList({ responses }: { responses: FormResponseDto[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <h3 className="label">{t('forms.answered')}</h3>
      <ul className="space-y-2" data-testid="record-responses">
        {responses.map((r) => (
          <li key={r.id} className="rounded-lg border border-slate-200 text-sm">
            <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <span>
                <b>📋 {r.formName}</b>
                <span className="block text-xs text-slate-500">
                  {r.serviceName ? `${r.serviceName} · ` : ''}
                  {r.appointmentAt ? dateTime(r.appointmentAt) : dateTime(r.createdAt)} · {r.source === 'customer' ? t('forms.byCustomer') : r.authorName ?? t('forms.byTeam')}
                </span>
              </span>
              <span className="text-slate-400">{open === r.id ? '▲' : '▼'}</span>
            </button>
            {open === r.id && (
              <dl className="space-y-1.5 border-t border-slate-100 px-3 py-2">
                {r.answers.map((a, i) => (
                  <div key={i}>
                    <dt className="text-xs text-slate-500">{a.label}</dt>
                    <dd className="whitespace-pre-wrap">{answerText(t, a)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
        {responses.length === 0 && <li className="text-sm text-slate-500">{t('forms.noneAnswered')}</li>}
      </ul>
    </div>
  );
}

/** Questionnaires of a booking: see what the customer answered or fill it in for them. */
export function AppointmentForms({ appointmentId }: { appointmentId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const enabled = useFeature('records');
  const list = useQuery({
    queryKey: ['appointment-forms', appointmentId],
    queryFn: () => api<AppointmentFormDto[]>(`/appointments/${appointmentId}/forms`),
    enabled,
    retry: false,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (formId: string) => api(`/appointments/${appointmentId}/forms`, { method: 'POST', body: { formId, values } }),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['appointment-forms', appointmentId] });
      void qc.invalidateQueries({ queryKey: ['record'] });
    },
  });
  if (!enabled || !list.data?.length) return null;
  return (
    <div className="space-y-2" data-testid="appointment-forms">
      <h3 className="label">{t('forms.title')}</h3>
      {list.data.map(({ form, response }) =>
        editing === form.id ? (
          <form
            key={form.id}
            className="space-y-3 rounded-lg border border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const err = formsError([form], { [form.id]: values });
              setLocalErr(err);
              if (!err) save.mutate(form.id);
            }}
          >
            <FormFields form={form} values={values} onChange={setValues} prefix="appt" />
            {localErr && <p className="text-sm text-rose-700" role="alert">{t(`forms.${localErr}`)}</p>}
            <ErrorText error={save.error} ns="forms" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
            </div>
          </form>
        ) : (
          <div key={form.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>
                📋 <b>{form.name}</b>{' '}
                {response ? (
                  <span className="text-xs text-emerald-700">✓ {response.source === 'customer' ? t('forms.answeredByCustomer') : t('forms.answeredBy', { name: response.authorName ?? '' })}</span>
                ) : (
                  <span className="text-xs text-amber-700">{t('forms.pending')}</span>
                )}
              </span>
              {form.fields.length > 0 && (
                <button
                  type="button"
                  className={response ? 'text-xs text-brand-700 hover:underline' : 'btn-primary !px-3 !py-1 text-xs'}
                  onClick={() => { setValues(valuesFrom(response)); setLocalErr(null); setEditing(form.id); }}
                >
                  {response ? t('common.edit') : t('forms.fill')}
                </button>
              )}
            </div>
            {response && (
              <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {response.answers.map((a, i) => (
                  <div key={i}>
                    <dt className="text-xs text-slate-500">{a.label}</dt>
                    <dd className="whitespace-pre-wrap">{answerText(t, a)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ),
      )}
    </div>
  );
}

// ---------- Builder (Configuración → Cuestionarios) ----------

type Draft = { id?: string; name: string; description: string; fields: (FormField & { optionsText: string })[]; serviceIds: string[]; active: boolean };

const toDraft = (f?: FormDto): Draft =>
  f
    ? { id: f.id, name: f.name, description: f.description ?? '', fields: f.fields.map((x) => ({ ...x, optionsText: x.options.join('\n') })), serviceIds: f.serviceIds, active: f.active }
    : { name: '', description: '', fields: [{ id: newId(), label: '', type: 'text', required: false, options: [], help: null, optionsText: '' }], serviceIds: [], active: true };

export function FormsSection({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const enabled = useFeature('records');
  const services = useServices();
  const list = useQuery({ queryKey: ['forms'], queryFn: () => api<FormDto[]>('/forms'), enabled });
  const [draft, setDraft] = useState<Draft | null>(null);
  const done = () => {
    setDraft(null);
    void qc.invalidateQueries({ queryKey: ['forms'] });
  };
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api(d.id ? `/forms/${d.id}` : '/forms', {
        method: d.id ? 'PUT' : 'POST',
        body: {
          name: d.name,
          description: d.description.trim() || null,
          fields: d.fields.map(({ optionsText, ...f }) => ({
            ...f,
            help: f.help?.trim() || null,
            options: hasOptions(f.type) ? optionsText.split('\n').map((x) => x.trim()).filter(Boolean) : [],
          })),
          serviceIds: d.serviceIds,
          active: d.active,
        },
      }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/forms/${id}`, { method: 'DELETE' }), onSuccess: done });
  const svcName = (id: string) => services.data?.find((s) => s.id === id)?.name ?? '';
  const setField = (i: number, patch: Partial<Draft['fields'][number]>) =>
    draft && setDraft({ ...draft, fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, d: -1 | 1) => {
    if (!draft) return;
    const fields = [...draft.fields];
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j]!, fields[i]!];
    setDraft({ ...draft, fields });
  };

  return (
    <section className="card space-y-4" data-testid="forms-section">
      <div>
        <h2 className="font-semibold">📋 {t('forms.title')}</h2>
        <p className="text-sm text-slate-500">{t('forms.help')}</p>
      </div>
      {!enabled && <UpgradeNote feature="records" />}
      {enabled && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {(list.data ?? []).map((f) => (
            <li key={f.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${f.active ? '' : 'opacity-50'}`}>
              <div>
                <div className="font-medium">{f.name}</div>
                <div className="text-xs text-slate-500">
                  {t('forms.questions', { count: f.fields.length })} · {f.serviceIds.length ? f.serviceIds.map(svcName).filter(Boolean).join(', ') : t('forms.noServices')}
                  {f.responses > 0 && ` · ${t('forms.responses', { count: f.responses })}`}
                </div>
              </div>
              {!disabled && (
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-brand-700 hover:underline" onClick={() => setDraft(toDraft(f))}>{t('common.edit')}</button>
                  <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('forms.deleteConfirm')) && remove.mutate(f.id)}>{t('common.delete')}</button>
                </div>
              )}
            </li>
          ))}
          {list.data?.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t('forms.empty')}</li>}
        </ul>
      )}
      {draft ? (
        <form className="space-y-4 rounded-lg border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }} data-testid="form-builder">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="fm-name">{t('forms.name')}</label>
              <input id="fm-name" required minLength={2} maxLength={100} className="input" placeholder={t('forms.namePlaceholder')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="fm-desc">{t('forms.description')}</label>
              <input id="fm-desc" maxLength={500} className="input" placeholder={t('forms.descriptionPlaceholder')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="label">{t('forms.questionsTitle')}</h3>
            {draft.fields.map((f, i) => (
              <div key={f.id} className="space-y-2 rounded-lg bg-slate-50 p-2" data-testid="form-question">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-400">{i + 1}.</span>
                  <input required maxLength={200} className="input min-w-0 flex-1" placeholder={t('forms.questionPlaceholder')} aria-label={t('forms.question')} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <select className="input !w-auto" aria-label={t('forms.type')} value={f.type} onChange={(e) => setField(i, { type: e.target.value as FormFieldType })}>
                    {FORM_FIELD_TYPES.map((ty) => <option key={ty} value={ty}>{t(`forms.types.${ty}`)}</option>)}
                  </select>
                </div>
                {hasOptions(f.type) && (
                  <textarea rows={3} required className="input" aria-label={t('forms.options')} placeholder={t('forms.optionsPlaceholder')} value={f.optionsText} onChange={(e) => setField(i, { optionsText: e.target.value })} />
                )}
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                    {t('forms.required')}
                  </label>
                  <input className="input !py-1 min-w-0 flex-1 text-xs" maxLength={200} placeholder={t('forms.helpPlaceholder')} value={f.help ?? ''} onChange={(e) => setField(i, { help: e.target.value })} aria-label={t('forms.helpText')} />
                  <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => move(i, -1)} aria-label={t('forms.up')} disabled={i === 0}>↑</button>
                  <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => move(i, 1)} aria-label={t('forms.down')} disabled={i === draft.fields.length - 1}>↓</button>
                  {draft.fields.length > 1 && (
                    <button type="button" className="text-rose-700 hover:underline" onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>{t('common.delete')}</button>
                  )}
                </div>
              </div>
            ))}
            {draft.fields.length < 40 && (
              <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setDraft({ ...draft, fields: [...draft.fields, { id: newId(), label: '', type: 'text', required: false, options: [], help: null, optionsText: '' }] })}>
                + {t('forms.addQuestion')}
              </button>
            )}
          </div>

          <fieldset>
            <legend className="label">{t('forms.services')}</legend>
            <div className="flex flex-wrap gap-2">
              {(services.data ?? []).filter((s) => s.active).map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs">
                  <input type="checkbox" checked={draft.serviceIds.includes(s.id)} onChange={(e) => setDraft({ ...draft, serviceIds: e.target.checked ? [...draft.serviceIds, s.id] : draft.serviceIds.filter((x) => x !== s.id) })} />
                  {s.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">{t('forms.servicesHelp')}</p>
          </fieldset>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              {t('forms.active')}
            </label>
          </div>
          <ErrorText error={save.error} ns="forms" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
          </div>
        </form>
      ) : (
        !disabled && enabled && (
          <button type="button" className="btn-secondary" onClick={() => setDraft(toDraft())}>+ {t('forms.new')}</button>
        )
      )}
    </section>
  );
}
