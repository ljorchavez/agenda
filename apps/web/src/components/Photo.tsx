import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { ErrorText } from './ui';

/** Round picture with initials on a color when there's no photo. */
export function Avatar({ name, color, photoUrl, size = 40 }: { name: string; color?: string; photoUrl?: string | null; size?: number }) {
  const style = { width: size, height: size };
  if (photoUrl) return <img src={photoUrl} alt="" style={style} className="shrink-0 rounded-full object-cover" loading="lazy" />;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span style={{ ...style, background: color ?? '#0f766e', fontSize: size * 0.36 }} className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white">
      {initials}
    </span>
  );
}

/** Shrinks a picture in the browser (longest side 800 px, JPEG) so uploads are small and fast. */
async function shrink(file: File, maxSide = 800): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85));
}

/** Pick, upload and preview one photo. `value` is the saved https URL (or null). */
export function PhotoInput({
  value,
  onChange,
  name,
  color,
  shape = 'round',
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  name: string;
  color?: string;
  shape?: 'round' | 'wide';
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', new File([await shrink(file)], 'photo.jpg', { type: 'image/jpeg' }));
      const { url } = await api<{ url: string }>('/uploads/photo', { method: 'POST', body: form });
      onChange(url);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <div className="label">{t('photos.photo')}</div>
      <div className="flex items-center gap-3">
        {shape === 'wide' ? (
          value ? (
            <img src={value} alt="" className="h-16 w-24 rounded-lg object-cover" />
          ) : (
            <span className="flex h-16 w-24 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-400">{t('photos.none')}</span>
          )
        ) : (
          <Avatar name={name || '?'} color={color} photoUrl={value} size={56} />
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? t('common.loading') : value ? t('photos.change') : t('photos.add')}
          </button>
          {value && !busy && (
            <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => onChange(null)}>
              {t('photos.remove')}
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      <ErrorText error={error} />
    </div>
  );
}
