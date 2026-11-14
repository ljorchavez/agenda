import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProductSuggestionDto } from '@agenda/shared';
import { api } from '../lib/api';
import { ErrorText, Modal } from './ui';

/** A SKU from the product name: first letters of its words plus its numbers ("Gel fijador 250 ml" → GEL-FIJ-250ML). */
export function suggestSku(name: string, taken: string[] = []): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'CON', 'PARA', 'EN', 'A'].includes(w));
  const parts: string[] = [];
  for (const w of words) {
    const last = parts[parts.length - 1];
    // "250 ML" → "250ML"
    if (/^\d/.test(w)) parts.push(w);
    else if (last && /^\d+$/.test(last) && w.length <= 3) parts[parts.length - 1] = last + w;
    else parts.push(w.slice(0, 3));
  }
  const base = parts.slice(0, 4).join('-').slice(0, 24) || 'PROD';
  const used = new Set(taken.map((x) => x.toUpperCase()));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Category: one of the list, none, or a new one typed in place. */
export function CategoryField({ value, options, onChange }: { value: string | null; options: string[]; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  const known = !value || options.some((o) => o === value);
  const [typing, setTyping] = useState(!known);
  if (typing) {
    return (
      <span className="flex gap-1">
        <input autoFocus className="input" maxLength={60} placeholder={t('pos.settings.newCategory')} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} data-testid="product-category-new" />
        {options.length > 0 && (
          <button type="button" className="btn-secondary !px-2" onClick={() => { setTyping(false); onChange(null); }} title={t('pos.fields.pickCategory')}>▾</button>
        )}
      </span>
    );
  }
  return (
    <select
      className="input"
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__new') {
          setTyping(true);
          onChange(null);
        } else onChange(e.target.value || null);
      }}
      data-testid="product-category-select"
    >
      <option value="">{t('pos.inventory.noCategory')}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value="__new">+ {t('pos.fields.newCategory')}</option>
    </select>
  );
}

interface SatItem {
  key: string;
  description: string;
  own: boolean;
}

/** SAT product key: type words ("shampoo") or digits and pick from the list. */
export function SatKeyField({ value, onChange, productName }: { value: string | null; onChange: (v: string | null) => void; productName: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const search = useQuery({
    queryKey: ['sat-keys', debounced],
    queryFn: () => api<{ catalog: boolean; items: SatItem[] }>(`/invoicing/sat-keys?q=${encodeURIComponent(debounced)}`),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  return (
    <div className="relative" ref={box}>
      <div className="flex gap-1">
        <input
          className="input font-mono"
          inputMode="numeric"
          maxLength={8}
          placeholder="01010101"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '') || null)}
          data-testid="pf-sat"
        />
        <button
          type="button"
          className="btn-secondary !px-2.5 whitespace-nowrap text-xs"
          onClick={() => {
            setOpen((o) => !o);
            if (!q && productName.trim()) setQ(productName.trim().split(/\s+/).slice(0, 2).join(' '));
          }}
          data-testid="pf-sat-search"
        >
          🔎 {t('pos.fields.searchSat')}
        </button>
      </div>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg" data-testid="sat-results">
          <input autoFocus className="input mb-2 !py-1 text-sm" placeholder={t('pos.fields.satPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="max-h-56 overflow-y-auto text-sm">
            {(search.data?.items ?? []).map((it) => (
              <li key={it.key}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-brand-50"
                  onClick={() => {
                    onChange(it.key);
                    setOpen(false);
                  }}
                >
                  <span className="font-mono text-xs text-slate-500">{it.key}</span>
                  <span className="flex-1">{it.description}</span>
                  {it.own && <span className="text-[10px] uppercase text-brand-700">{t('pos.fields.yours')}</span>}
                </button>
              </li>
            ))}
            {search.isLoading && <li className="px-2 py-1 text-slate-400">{t('common.loading')}</li>}
          </ul>
          {search.data && !search.data.catalog && <p className="mt-1 text-xs text-slate-500">{t('pos.fields.satNoCatalog')}</p>}
          <a className="mt-1 block text-xs text-brand-700 hover:underline" href="http://pys.sat.gob.mx/PyS/catPyS.aspx" target="_blank" rel="noreferrer">
            {t('pos.fields.satSite')} ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ---------- Barcode scanning ----------

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector;
const Detector = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
/** Phones/browsers that can read barcodes with the camera (Chrome on Android, Edge…; not Safari yet). */
export const cameraScanAvailable = () => Boolean(Detector && navigator.mediaDevices?.getUserMedia);

/** Reads one barcode with the camera; USB/Bluetooth scanners just type the code (no button needed). */
export function CameraScanModal({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(cameraScanAvailable() ? null : 'unsupported');
  useEffect(() => {
    if (!cameraScanAvailable()) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const detector = new Detector!({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
        timer = setInterval(() => {
          if (done || !video.current || video.current.readyState < 2) return;
          void detector
            .detect(video.current)
            .then((codes) => {
              const code = codes[0]?.rawValue?.trim();
              if (code && !done) {
                done = true;
                navigator.vibrate?.(60);
                onCode(code);
              }
            })
            .catch(() => undefined);
        }, 250);
      })
      .catch(() => setError('denied'));
    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onCode]);
  return (
    <Modal open title={t('pos.scan.title')} onClose={onClose}>
      {error ? (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="scan-error">{t(`pos.scan.${error}`)}</p>
      ) : (
        <div className="space-y-2">
          <video ref={video} className="aspect-video w-full rounded-lg bg-black object-cover" muted playsInline />
          <p className="text-center text-xs text-slate-500">{t('pos.scan.aim')}</p>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button type="button" className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

/**
 * Catches a USB/Bluetooth barcode scanner anywhere on the page: it "types" the code very fast and
 * presses Enter. Keys typed in a field are left alone (the field handles them).
 */
export function useScannerInput(onCode: (code: string) => void, enabled = true) {
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = Date.now();
      if (now - last > 60) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= 4) {
          e.preventDefault();
          cb.current(buf);
        }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Whether the AI helpers are on for this server (the key is set in its environment). */
export function useAiEnabled() {
  return useQuery({ queryKey: ['ai-enabled'], queryFn: () => api<{ enabled: boolean }>('/products/ai'), staleTime: 3_600_000 }).data?.enabled ?? false;
}

/** A photo shrunk to at most 1280 px (JPEG) and sent as base64: small, fast and cheap to read. */
async function photoData(file: File): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.82).split(',')[1]!, mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "Llenar con IA": a photo of the label or a few words fill the new-product form, to review. */
export function AiFill({ onFill }: { onFill: (s: ProductSuggestionDto) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const ask = useMutation({
    mutationFn: async (v: { text?: string; photo?: File }) =>
      api<ProductSuggestionDto>('/products/ai-suggest', { method: 'POST', body: { text: v.text || undefined, image: v.photo ? await photoData(v.photo) : undefined } }),
    onSuccess: (r) => {
      onFill(r);
      setDone(true);
    },
  });
  if (!open) {
    return (
      <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setOpen(true)} data-testid="ai-fill">
        {t('pos.ai.button')}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-brand-100 bg-brand-50 p-3" data-testid="ai-fill-panel">
      <p className="text-xs text-slate-600">{t('pos.ai.help')}</p>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary shrink-0" disabled={ask.isPending} onClick={() => file.current?.click()} data-testid="ai-photo">{t('pos.ai.photo')}</button>
        <input className="input min-w-0 flex-1" maxLength={300} placeholder={t('pos.ai.placeholder')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) ask.mutate({ text: text.trim() }); } }} data-testid="ai-text" />
        <button type="button" className="btn-primary shrink-0" disabled={ask.isPending || !text.trim()} onClick={() => ask.mutate({ text: text.trim() })}>{ask.isPending ? t('pos.ai.thinking') : t('pos.ai.go')}</button>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) ask.mutate({ photo: f, text: text.trim() || undefined });
        }}
      />
      {ask.isPending && <p className="text-xs text-slate-500">{t('pos.ai.thinking')}</p>}
      {done && !ask.isPending && !ask.error && <p className="text-xs text-emerald-700" data-testid="ai-filled">{t('pos.ai.filled')}</p>}
      <ErrorText error={ask.error} ns="pos" />
    </div>
  );
}
