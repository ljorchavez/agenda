import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CUSTOM_FIELD_TYPES, type CustomClinicalTemplate } from '@agenda/shared';

type Field = CustomClinicalTemplate['fields'][number];

/** "Peso al nacer" → "pesoAlNacer" (unique within the template). */
function fieldId(label: string, taken: string[]): string {
  const words = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  let base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || 'campo';
  if (!/^[a-z]/.test(base)) base = `c${base}`;
  base = base.slice(0, 24);
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}${n}`;
  return id;
}
const newId = () => `custom_${Math.random().toString(36).slice(2, 10)}`;

/**
 * The business's own clinical templates (e.g. "Valoración de lactancia"): a title, whether it's a
 * history or a progress note, and its fields. Saved with the business settings.
 */
export function ClinicalTemplatesEditor({ value, onChange, disabled }: { value: CustomClinicalTemplate[]; onChange: (v: CustomClinicalTemplate[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<CustomClinicalTemplate | null>(null);
  const save = (tpl: CustomClinicalTemplate) => {
    const exists = value.some((x) => x.id === tpl.id);
    onChange(exists ? value.map((x) => (x.id === tpl.id ? tpl : x)) : [...value, tpl]);
    setEditing(null);
  };
  return (
    <section className="card space-y-3" data-testid="clinical-templates">
      <h2 className="font-semibold">🧩 {t('templates.title')}</h2>
      <p className="text-xs text-slate-500">{t('templates.help')}</p>
      <ul className="space-y-1 text-sm">
        {value.map((tpl) => (
          <li key={tpl.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
            <span><b>{tpl.title}</b> <span className="text-xs text-slate-500">· {t(`templates.kinds.${tpl.kind}`)} · {t('templates.fieldCount', { count: tpl.fields.length })}</span></span>
            {!disabled && (
              <span className="flex gap-3 text-xs">
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setEditing(tpl)}>{t('common.edit')}</button>
                <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('templates.deleteConfirm')) && onChange(value.filter((x) => x.id !== tpl.id))}>{t('common.delete')}</button>
              </span>
            )}
          </li>
        ))}
        {value.length === 0 && <li className="text-xs text-slate-500">{t('templates.none')}</li>}
      </ul>
      {!disabled && !editing && (
        <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setEditing({ id: newId(), title: '', kind: 'evolution', fields: [{ id: 'nota', label: t('templates.defaultField'), type: 'longtext', required: true }] })} data-testid="new-template">
          + {t('templates.new')}
        </button>
      )}
      {editing && <TemplateForm tpl={editing} onSave={save} onCancel={() => setEditing(null)} />}
    </section>
  );
}

function TemplateForm({ tpl, onSave, onCancel }: { tpl: CustomClinicalTemplate; onSave: (t: CustomClinicalTemplate) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(tpl);
  const setField = (i: number, p: Partial<Field>) => setV({ ...v, fields: v.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const valid = v.title.trim().length >= 2 && v.fields.length > 0 && v.fields.every((f) => f.label.trim() && (f.type !== 'select' || (f.options?.length ?? 0) > 0));
  return (
    <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3" data-testid="template-form">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-sm sm:col-span-2">
          <span className="label">{t('templates.name')}</span>
          <input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder={t('templates.namePlaceholder')} />
        </label>
        <label className="block text-sm">
          <span className="label">{t('templates.kind')}</span>
          <select className="input" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as CustomClinicalTemplate['kind'] })}>
            <option value="evolution">{t('templates.kinds.evolution')}</option>
            <option value="history">{t('templates.kinds.history')}</option>
          </select>
        </label>
      </div>
      <ol className="space-y-2">
        {v.fields.map((f, i) => (
          <li key={i} className="grid gap-1.5 rounded-lg bg-white p-2 sm:grid-cols-[1fr_11rem_auto_auto]">
            <input className="input !py-1.5 text-sm" placeholder={t('templates.fieldLabel')} aria-label={t('templates.fieldLabel')} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
            <select className="input !py-1.5 text-sm" aria-label={t('templates.fieldType')} value={f.type} onChange={(e) => setField(i, { type: e.target.value as Field['type'] })}>
              {CUSTOM_FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`templates.types.${x}`)}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={Boolean(f.required)} onChange={(e) => setField(i, { required: e.target.checked })} /> {t('templates.required')}</label>
            <span className="flex gap-1 text-xs">
              <button type="button" disabled={i === 0} className="px-1 text-slate-500 disabled:opacity-30" aria-label="↑" onClick={() => { const fs = [...v.fields]; [fs[i - 1], fs[i]] = [fs[i]!, fs[i - 1]!]; setV({ ...v, fields: fs }); }}>↑</button>
              <button type="button" className="px-1 text-rose-700" aria-label={t('common.remove')} onClick={() => setV({ ...v, fields: v.fields.filter((_, j) => j !== i) })}>✕</button>
            </span>
            {f.type === 'select' && (
              <input className="input !py-1.5 text-sm sm:col-span-4" placeholder={t('templates.options')} aria-label={t('templates.options')} value={(f.options ?? []).join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-between gap-2">
        <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setV({ ...v, fields: [...v.fields, { id: '', label: '', type: 'text' }] })} disabled={v.fields.length >= 40}>
          + {t('templates.addField')}
        </button>
        <span className="flex gap-2">
          <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            type="button"
            className="btn-primary !py-1.5 text-sm"
            disabled={!valid}
            data-testid="save-template"
            onClick={() => {
              const taken: string[] = [];
              const fields = v.fields.map((f) => {
                const id = f.id && !taken.includes(f.id) ? f.id : fieldId(f.label, taken);
                taken.push(id);
                return { ...f, id, label: f.label.trim(), options: f.type === 'select' ? f.options : undefined };
              });
              onSave({ ...v, title: v.title.trim(), fields });
            }}
          >
            {t('templates.done')}
          </button>
        </span>
      </div>
    </div>
  );
}
