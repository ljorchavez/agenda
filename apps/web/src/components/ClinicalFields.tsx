import { createContext, useContext, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MEDICATIONS_COMMON,
  allergyConflict,
  searchCie10,
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  TOOTH_STATES,
  TOOTH_SURFACES,
  bmi,
  type Anthropometry,
  type ClinicalField,
  type ConsentSignatures,
  type Diagnosis,
  type Medication,
  type Odontogram,
  type SignatureMark,
  type ToothState,
  type Vitals,
} from '@agenda/shared';
import { dateOnly } from '../lib/format';

/** Inputs and read-only views for each kind of clinical field. */

const num = (v: string) => (v === '' ? null : Number(v));
const small = 'input !h-9 !py-1 text-sm';

function NumberBox({ label, unit, value, onChange, step = 'any' }: { label: string; unit?: string; value: number | null | undefined; onChange: (v: number | null) => void; step?: string }) {
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <span className="flex items-center gap-1">
        <input type="number" step={step} className={small} value={value ?? ''} onChange={(e) => onChange(num(e.target.value))} />
        {unit && <span className="shrink-0 text-slate-400">{unit}</span>}
      </span>
    </label>
  );
}

export function VitalsInput({ value, onChange }: { value: Vitals | undefined; onChange: (v: Vitals) => void }) {
  const v = value ?? {};
  const set = (p: Partial<Vitals>) => onChange({ ...v, ...p });
  const imc = bmi(v.peso, v.talla);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="vitals">
      <label className="block text-xs text-slate-600">
        TA
        <span className="flex items-center gap-1">
          <input className={small} placeholder="120/80" value={v.ta ?? ''} onChange={(e) => set({ ta: e.target.value })} />
          <span className="shrink-0 text-slate-400">mmHg</span>
        </span>
      </label>
      <NumberBox label="FC" unit="lpm" value={v.fc} onChange={(x) => set({ fc: x })} />
      <NumberBox label="FR" unit="rpm" value={v.fr} onChange={(x) => set({ fr: x })} />
      <NumberBox label="Temp." unit="°C" value={v.temp} onChange={(x) => set({ temp: x })} />
      <NumberBox label="SpO₂" unit="%" value={v.spo2} onChange={(x) => set({ spo2: x })} />
      <NumberBox label="Peso" unit="kg" value={v.peso} onChange={(x) => set({ peso: x })} />
      <NumberBox label="Talla" unit="cm" value={v.talla} onChange={(x) => set({ talla: x })} />
      <div className="text-xs text-slate-600">
        IMC
        <div className="flex h-9 items-center font-medium text-slate-800">{imc ?? '—'}</div>
      </div>
    </div>
  );
}

export function AnthropometryInput({ value, onChange }: { value: Anthropometry | undefined; onChange: (v: Anthropometry) => void }) {
  const v = value ?? {};
  const set = (p: Partial<Anthropometry>) => onChange({ ...v, ...p });
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-6" data-testid="anthropometry">
      <NumberBox label="Peso" unit="kg" value={v.peso} onChange={(x) => set({ peso: x })} />
      <NumberBox label="Talla" unit="cm" value={v.talla} onChange={(x) => set({ talla: x })} />
      <div className="text-xs text-slate-600">
        IMC
        <div className="flex h-9 items-center font-medium text-slate-800">{bmi(v.peso, v.talla) ?? '—'}</div>
      </div>
      <NumberBox label="Cintura" unit="cm" value={v.cintura} onChange={(x) => set({ cintura: x })} />
      <NumberBox label="Cadera" unit="cm" value={v.cadera} onChange={(x) => set({ cadera: x })} />
      <NumberBox label="Grasa" unit="%" value={v.grasa} onChange={(x) => set({ grasa: x })} />
    </div>
  );
}

/** Allergies of the patient being written about, for the prescription check. */
export const ClinicalPatientContext = createContext<{ allergies: string | null }>({ allergies: null });

/** One diagnosis: type a code or words and pick from the CIE-10 list (or write your own). */
function DiagnosisRow({ d, onChange, onRemove }: { d: Diagnosis; onChange: (p: Partial<Diagnosis>) => void; onRemove?: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const hits = open ? searchCie10(q || d.text || d.code || '', 8) : [];
  return (
    <div className="relative flex gap-2">
      <input className={`${small} !w-24 font-mono uppercase`} placeholder="CIE-10" aria-label="CIE-10" value={d.code ?? ''} onChange={(e) => { onChange({ code: e.target.value.toUpperCase() }); setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} />
      <input className={small} placeholder={t('clinical.diagnosisSearch')} aria-label={t('clinical.diagnosisText')} value={d.text} onChange={(e) => { onChange({ text: e.target.value }); setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} />
      {onRemove && <button type="button" className="text-slate-400 hover:text-rose-700" aria-label={t('common.remove')} onClick={onRemove}>✕</button>}
      {hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white text-sm shadow-lg" role="listbox" data-testid="cie10-options">
          {hits.map((h) => (
            <li key={h.code}>
              <button type="button" role="option" aria-selected={false} className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-brand-50" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange({ code: h.code, text: h.title }); setOpen(false); setQ(''); }}>
                <b className="w-14 shrink-0 font-mono">{h.code}</b>
                <span>{h.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DiagnosesInput({ value, onChange }: { value: Diagnosis[] | undefined; onChange: (v: Diagnosis[]) => void }) {
  const { t } = useTranslation();
  const list = value?.length ? value : [{ code: '', text: '' }];
  const set = (i: number, p: Partial<Diagnosis>) => onChange(list.map((d, j) => (j === i ? { ...d, ...p } : d)));
  return (
    <div className="space-y-1.5" data-testid="diagnoses">
      {list.map((d, i) => (
        <DiagnosisRow key={i} d={d} onChange={(p) => set(i, p)} onRemove={list.length > 1 ? () => onChange(list.filter((_, j) => j !== i)) : undefined} />
      ))}
      <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => onChange([...list, { code: '', text: '' }])}>+ {t('clinical.addDiagnosis')}</button>
    </div>
  );
}
const EMPTY_MED: Medication = { name: '', dose: '', route: '', frequency: '', duration: '' };
export function MedicationsInput({ value, onChange }: { value: Medication[] | undefined; onChange: (v: Medication[]) => void }) {
  const { t } = useTranslation();
  const { allergies } = useContext(ClinicalPatientContext);
  const list = value?.length ? value : [{ ...EMPTY_MED }];
  const set = (i: number, p: Partial<Medication>) => onChange(list.map((d, j) => (j === i ? { ...d, ...p } : d)));
  return (
    <div className="space-y-2" data-testid="medications">
      {list.map((m, i) => (
        <div key={i} className="grid grid-cols-2 gap-1.5 rounded-lg bg-slate-50 p-2 sm:grid-cols-5">
          <input className={`${small} col-span-2 sm:col-span-1`} placeholder={t('clinical.medName')} aria-label={t('clinical.medName')} list="med-names" value={m.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input className={small} placeholder={t('clinical.medDose')} aria-label={t('clinical.medDose')} value={m.dose} onChange={(e) => set(i, { dose: e.target.value })} />
          <input className={small} placeholder={t('clinical.medRoute')} aria-label={t('clinical.medRoute')} list="med-routes" value={m.route} onChange={(e) => set(i, { route: e.target.value })} />
          <input className={small} placeholder={t('clinical.medFrequency')} aria-label={t('clinical.medFrequency')} value={m.frequency} onChange={(e) => set(i, { frequency: e.target.value })} />
          <span className="flex gap-1">
            <input className={small} placeholder={t('clinical.medDuration')} aria-label={t('clinical.medDuration')} value={m.duration ?? ''} onChange={(e) => set(i, { duration: e.target.value })} />
            {list.length > 1 && <button type="button" className="text-slate-400 hover:text-rose-700" aria-label={t('common.remove')} onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>}
          </span>
          {allergyConflict(allergies, m.name) && (
            <p className="col-span-full rounded bg-rose-50 px-2 py-1 text-xs font-medium text-rose-800" role="alert" data-testid="allergy-alert">
              ⚠️ {t('clinical.allergyAlert', { group: allergyConflict(allergies, m.name), allergies })}
            </p>
          )}
        </div>
      ))}
      <datalist id="med-names">
        {MEDICATIONS_COMMON.map((n) => <option key={n} value={n} />)}
      </datalist>
      <datalist id="med-routes">
        {['Oral', 'Sublingual', 'Tópica', 'Intramuscular', 'Intravenosa', 'Subcutánea', 'Inhalada', 'Oftálmica', 'Ótica', 'Rectal'].map((r) => <option key={r} value={r} />)}
      </datalist>
      <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => onChange([...list, { ...EMPTY_MED }])}>+ {t('clinical.addMedication')}</button>
    </div>
  );
}

export function PainInput({ value, onChange }: { value: number | undefined | null; onChange: (v: number) => void }) {
  const v = typeof value === 'number' ? value : null;
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" data-testid="pain">
      {Array.from({ length: 11 }, (_, n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={v === n}
          onClick={() => onChange(n)}
          className={`h-8 w-8 rounded-full border text-sm font-medium ${v === n ? 'border-transparent text-white' : 'border-slate-200 text-slate-600'}`}
          style={v === n ? { background: `hsl(${120 - n * 12} 70% 40%)` } : undefined}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// ---------- Odontogram (NOM-013) ----------

export const TOOTH_COLORS: Record<ToothState, string> = {
  sano: '#ffffff',
  caries: '#ef4444',
  obturado: '#3b82f6',
  corona: '#f59e0b',
  endodoncia: '#8b5cf6',
  ausente: '#94a3b8',
  extraccion: '#b91c1c',
  implante: '#14b8a6',
  fractura: '#f97316',
  protesis: '#6366f1',
};

function Tooth({ n, mark, onClick, readOnly }: { n: string; mark: Odontogram[string] | undefined; onClick?: () => void; readOnly?: boolean }) {
  const st = mark?.state ?? 'sano';
  const crossed = st === 'ausente' || st === 'extraccion';
  return (
    <button
      type="button"
      disabled={readOnly}
      onClick={onClick}
      data-testid={`tooth-${n}`}
      title={`${n}${mark ? ` · ${mark.state}${mark.surfaces?.length ? ` (${mark.surfaces.join('')})` : ''}` : ''}`}
      className="flex w-7 flex-col items-center text-[10px] text-slate-500 disabled:cursor-default sm:w-8"
    >
      <span
        className="relative flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 sm:h-8 sm:w-8"
        style={{ background: TOOTH_COLORS[st] }}
      >
        {crossed && <span className="absolute text-base font-bold text-white">✕</span>}
        {mark?.surfaces?.length ? <span className="text-[9px] font-semibold text-white mix-blend-difference">{mark.surfaces.join('')}</span> : null}
      </span>
      {n}
    </button>
  );
}

export function OdontogramInput({ value, onChange, readOnly }: { value: Odontogram | undefined; onChange?: (v: Odontogram) => void; readOnly?: boolean }) {
  const { t } = useTranslation();
  const v = value ?? {};
  const [primary, setPrimary] = useState(() => Object.keys(v).some((k) => Number(k[0]) >= 5));
  const [open, setOpen] = useState<string | null>(null);
  const teeth = primary ? PRIMARY_TEETH : PERMANENT_TEETH;
  const setMark = (n: string, mark: Odontogram[string] | null) => {
    const next = { ...v };
    if (!mark || (mark.state === 'sano' && !mark.surfaces?.length)) delete next[n];
    else next[n] = mark;
    onChange?.(next);
  };
  const row = (list: string[]) => (
    <div className="flex justify-center gap-0.5">
      {list.map((n, i) => (
        <span key={n} className={i === list.length / 2 ? 'ml-2 border-l border-slate-300 pl-2' : ''}>
          <Tooth n={n} mark={v[n]} readOnly={readOnly} onClick={() => setOpen(open === n ? null : n)} />
        </span>
      ))}
    </div>
  );
  const cur = open ? v[open] : undefined;
  return (
    <div className="space-y-2" data-testid="odontogram">
      {!readOnly && (
        <div className="flex gap-2 text-xs">
          <button type="button" className={`rounded-full border px-2 py-0.5 ${!primary ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`} onClick={() => setPrimary(false)}>{t('clinical.permanent')}</button>
          <button type="button" className={`rounded-full border px-2 py-0.5 ${primary ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`} onClick={() => setPrimary(true)}>{t('clinical.primary')}</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <div className="inline-block min-w-full space-y-2 py-1">
          {row(teeth.upper)}
          {row(teeth.lower)}
        </div>
      </div>
      {open && !readOnly && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-2 text-sm" data-testid="tooth-editor">
          <div className="font-medium">{t('clinical.tooth', { n: open })}</div>
          <div className="flex flex-wrap gap-1">
            {TOOTH_STATES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setMark(open, { state: s, surfaces: s === 'caries' || s === 'obturado' ? cur?.surfaces ?? [] : [] })}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${(cur?.state ?? 'sano') === s ? 'border-brand-600 bg-brand-50 font-medium' : 'border-slate-200'}`}
              >
                <span className="h-2.5 w-2.5 rounded-full border border-slate-300" style={{ background: TOOTH_COLORS[s] }} />
                {t(`clinical.toothStates.${s}`)}
              </button>
            ))}
          </div>
          {(cur?.state === 'caries' || cur?.state === 'obturado') && (
            <div className="flex items-center gap-1 text-xs">
              {t('clinical.surfaces')}:
              {TOOTH_SURFACES.map((f) => (
                <label key={f} className="flex items-center gap-0.5">
                  <input
                    type="checkbox"
                    checked={cur.surfaces?.includes(f) ?? false}
                    onChange={(e) => setMark(open, { ...cur, surfaces: e.target.checked ? [...(cur.surfaces ?? []), f] : (cur.surfaces ?? []).filter((x) => x !== f) })}
                  />
                  {f}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {TOOTH_STATES.filter((s) => s !== 'sano').map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm border border-slate-300" style={{ background: TOOTH_COLORS[s] }} />
            {t(`clinical.toothStates.${s}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- Signatures (consentimiento informado) ----------

function SignaturePad({ value, onChange, label }: { value: SignatureMark | undefined; onChange: (v: SignatureMark) => void; label: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const v = value ?? { name: '', image: null };
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (v.image) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = v.image;
    }
    // Only when the stored image changes from outside
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.image === null]);
  const pos = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * e.currentTarget.width) / r.width, y: ((e.clientY - r.top) * e.currentTarget.height) / r.height };
  };
  return (
    <div className="space-y-1 rounded-lg border border-slate-200 p-2">
      <div className="text-xs font-medium text-slate-700">{label}</div>
      <input className={small} placeholder={t('clinical.signerName')} aria-label={`${label}: ${t('clinical.signerName')}`} value={v.name} onChange={(e) => onChange({ ...v, name: e.target.value })} />
      <canvas
        ref={ref}
        width={320}
        height={110}
        aria-label={`${label}: ${t('clinical.signHere')}`}
        className="w-full touch-none rounded bg-slate-50"
        onPointerDown={(e) => {
          drawing.current = true;
          const ctx = e.currentTarget.getContext('2d')!;
          const p = pos(e);
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#0f172a';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d')!;
          const p = pos(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }}
        onPointerUp={(e) => {
          if (!drawing.current) return;
          drawing.current = false;
          onChange({ ...v, image: e.currentTarget.toDataURL('image/png') });
        }}
      />
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>{v.image ? `✓ ${t('clinical.signed')}` : t('clinical.signHere')}</span>
        {v.image && <button type="button" className="text-rose-700 hover:underline" onClick={() => onChange({ ...v, image: null })}>{t('clinical.clear')}</button>}
      </div>
    </div>
  );
}

export function SignaturesInput({ value, onChange }: { value: ConsentSignatures | undefined; onChange: (v: ConsentSignatures) => void }) {
  const { t } = useTranslation();
  const v = value ?? {};
  const roles = ['patient', 'doctor', 'witness1', 'witness2'] as const;
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="signatures">
      {roles.map((r) => (
        <SignaturePad key={r} label={t(`clinical.signers.${r}`)} value={v[r]} onChange={(m) => onChange({ ...v, [r]: m })} />
      ))}
    </div>
  );
}

// ---------- One field: input or read-only ----------

export function ClinicalFieldInput({ field, value, onChange }: { field: ClinicalField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation();
  const id = `cf-${field.id}`;
  const label = (
    <span className="label" id={`${id}-l`}>
      {field.label}
      {field.required && <span className="text-rose-600"> *</span>}
      {field.unit && <span className="ml-1 font-normal text-slate-400">({field.unit})</span>}
      {field.help && <span className="ml-1 font-normal text-slate-400">({field.help})</span>}
    </span>
  );
  switch (field.type) {
    case 'longtext':
      return (
        <label className="block" htmlFor={id}>
          {label}
          <textarea id={id} rows={3} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case 'number':
      return (
        <label className="block" htmlFor={id}>
          {label}
          <input id={id} type="number" step="any" className="input" value={(value as number | null) ?? ''} onChange={(e) => onChange(num(e.target.value))} />
        </label>
      );
    case 'date':
      return (
        <label className="block" htmlFor={id}>
          {label}
          <input id={id} type="date" className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case 'select':
      return (
        <label className="block" htmlFor={id}>
          {label}
          <select id={id} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      );
    case 'yesno':
      return (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>
            {field.label}
            {field.required && <span className="text-rose-600"> *</span>}
          </span>
        </label>
      );
    case 'vitals':
      return <div>{label}<VitalsInput value={value as Vitals} onChange={onChange} /></div>;
    case 'anthropometry':
      return <div>{label}<AnthropometryInput value={value as Anthropometry} onChange={onChange} /></div>;
    case 'diagnoses':
      return <div>{label}<DiagnosesInput value={value as Diagnosis[]} onChange={onChange} /></div>;
    case 'medications':
      return <div>{label}<MedicationsInput value={value as Medication[]} onChange={onChange} /></div>;
    case 'odontogram':
      return <div>{label}<OdontogramInput value={value as Odontogram} onChange={onChange} /></div>;
    case 'pain':
      return <div>{label}<PainInput value={value as number} onChange={onChange} /></div>;
    case 'signatures':
      return <div>{label}<SignaturesInput value={value as ConsentSignatures} onChange={onChange} /></div>;
    default:
      return (
        <label className="block" htmlFor={id}>
          {label}
          <input id={id} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={t('clinical.field')} />
        </label>
      );
  }
}

const isEmpty = (v: unknown) =>
  v == null ||
  v === '' ||
  (Array.isArray(v) && !v.some((x) => (typeof x === 'object' && x ? Object.values(x).some((y) => y !== '' && y != null) : Boolean(x)))) ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.values(v as object).some((y) => y !== '' && y != null));

/** Read-only value; null when there's nothing to show. */
export function ClinicalFieldValue({ field, value }: { field: ClinicalField; value: unknown }) {
  const { t } = useTranslation();
  if (isEmpty(value) && field.type !== 'yesno') return null;
  let body: ReactNode;
  switch (field.type) {
    case 'vitals': {
      const v = value as Vitals;
      body = [
        v.ta && `TA ${v.ta} mmHg`,
        v.fc != null && `FC ${v.fc} lpm`,
        v.fr != null && `FR ${v.fr} rpm`,
        v.temp != null && `Temp ${v.temp} °C`,
        v.spo2 != null && `SpO₂ ${v.spo2}%`,
        v.peso != null && `Peso ${v.peso} kg`,
        v.talla != null && `Talla ${v.talla} cm`,
        bmi(v.peso, v.talla) != null && `IMC ${bmi(v.peso, v.talla)}`,
      ].filter(Boolean).join(' · ');
      break;
    }
    case 'anthropometry': {
      const v = value as Anthropometry;
      body = [
        v.peso != null && `Peso ${v.peso} kg`,
        v.talla != null && `Talla ${v.talla} cm`,
        bmi(v.peso, v.talla) != null && `IMC ${bmi(v.peso, v.talla)}`,
        v.cintura != null && `Cintura ${v.cintura} cm`,
        v.cadera != null && `Cadera ${v.cadera} cm`,
        v.grasa != null && `Grasa ${v.grasa}%`,
      ].filter(Boolean).join(' · ');
      break;
    }
    case 'diagnoses':
      body = (
        <ul className="list-disc pl-5">
          {(value as Diagnosis[]).filter((d) => d.text || d.code).map((d, i) => <li key={i}>{d.code ? <b className="font-mono">{d.code} </b> : null}{d.text}</li>)}
        </ul>
      );
      break;
    case 'medications':
      body = (
        <ol className="list-decimal pl-5">
          {(value as Medication[]).filter((m) => m.name).map((m, i) => (
            <li key={i}><b>{m.name}</b> — {[m.dose, m.route, m.frequency, m.duration].filter(Boolean).join(', ')}</li>
          ))}
        </ol>
      );
      break;
    case 'odontogram':
      body = <OdontogramInput value={value as Odontogram} readOnly />;
      break;
    case 'pain':
      body = `${value as number}/10`;
      break;
    case 'yesno':
      body = value === true ? t('forms.yes') : t('forms.no');
      break;
    case 'date':
      body = dateOnly(value as string);
      break;
    case 'signatures': {
      const v = value as ConsentSignatures;
      body = (
        <div className="grid grid-cols-2 gap-3">
          {(['patient', 'doctor', 'witness1', 'witness2'] as const).map((r) => (
            <div key={r} className="text-center text-xs">
              {v[r]?.image ? <img src={v[r]!.image!} alt="" className="mx-auto h-14" /> : <div className="h-14" />}
              <div className="border-t border-slate-400 pt-0.5">{v[r]?.name || '—'}</div>
              <div className="text-slate-500">{t(`clinical.signers.${r}`)}</div>
            </div>
          ))}
        </div>
      );
      break;
    }
    default:
      body = <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
  return (
    <div className="text-sm">
      <div className="text-xs font-medium text-slate-500">{field.label}</div>
      <div className="text-slate-800">{body}</div>
    </div>
  );
}
