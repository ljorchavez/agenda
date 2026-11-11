import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RECORD_PHOTO_MAX_BYTES, type CustomerRecordDto, type RecordPhotoDto } from '@agenda/shared';
import { api, ApiError, tokenStore } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime } from '../lib/format';
import { shrink } from './Photo';
import { ErrorText } from './ui';
import { UpgradeNote, useFeature } from './Sales';

/** A private photo: fetched with the login's token and shown from memory, never by public URL. */
function PrivatePhoto({ photo, onOpen }: { photo: RecordPhotoDto; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    void fetch(`/api/record-photos/${photo.id}`, { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) {
          revoke = URL.createObjectURL(b);
          setUrl(revoke);
        }
      });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [photo.id]);
  return (
    <button type="button" className="aspect-square w-full overflow-hidden rounded-lg bg-slate-100" onClick={() => url && onOpen(url)}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <span className="text-xs text-slate-400">…</span>}
    </button>
  );
}

/**
 * Expediente: allergies, conditions/medication, consent, dated notes with author and photos.
 * Shown only to owners, admins and whoever attended the customer (the API enforces it).
 */
export function RecordSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const enabled = useFeature('records');
  const rec = useQuery({
    queryKey: ['record', customerId],
    queryFn: () => api<CustomerRecordDto>(`/customers/${customerId}/record`),
    enabled,
    retry: false,
  });
  const [allergies, setAllergies] = useState('');
  const [conditions, setConditions] = useState('');
  const [note, setNote] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [kind, setKind] = useState<'before' | 'after' | 'other'>('before');
  const [photoNote, setPhotoNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rec.data) {
      setAllergies(rec.data.allergies ?? '');
      setConditions(rec.data.conditions ?? '');
    }
  }, [rec.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['record', customerId] });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/customers/${customerId}/record`, { method: 'PUT', body }),
    onSuccess: refresh,
  });
  const addNote = useMutation({
    mutationFn: () => api(`/customers/${customerId}/record/notes`, { method: 'POST', body: { body: note } }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const delNote = useMutation({ mutationFn: (id: string) => api(`/record-notes/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const small = await shrink(file, 1600);
      if (small.size > RECORD_PHOTO_MAX_BYTES) throw new ApiError(422, 'image_too_large');
      const form = new FormData();
      form.append('file', new File([small], 'foto.jpg', { type: 'image/jpeg' }));
      form.append('kind', kind);
      if (photoNote.trim()) form.append('note', photoNote.trim());
      return api(`/customers/${customerId}/record/photos`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      setPhotoNote('');
      refresh();
    },
  });
  const delPhoto = useMutation({ mutationFn: (id: string) => api(`/record-photos/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  if (!enabled) {
    return (
      <section className="card space-y-2">
        <h2 className="font-semibold">🩺 {t('record.title')}</h2>
        <UpgradeNote feature="records" />
      </section>
    );
  }
  // Not allowed (a colaborador who didn't attend this customer): hide the section.
  if (rec.error instanceof ApiError && rec.error.status === 403) return null;
  const d = rec.data;
  return (
    <section className="card space-y-4" data-testid="record-section">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">🩺 {t('record.title')}</h2>
          <p className="text-xs text-slate-500">🔒 {t('record.private')}</p>
        </div>
        {d && (
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
            <input type="checkbox" checked={Boolean(d.consentAt)} onChange={(e) => save.mutate({ consent: e.target.checked })} data-testid="record-consent" />
            <span>
              {t('record.consent')}
              {d.consentAt && <span className="block text-xs text-slate-500">{t('record.consentBy', { date: dateOnly(d.consentAt), name: d.consentByName ?? '' })}</span>}
            </span>
          </label>
        )}
      </div>
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="rec-all">{t('record.allergies')}</label>
              <textarea id="rec-all" rows={2} className="input" value={allergies} onChange={(e) => setAllergies(e.target.value)} onBlur={() => allergies !== (d.allergies ?? '') && save.mutate({ allergies: allergies || null })} />
            </div>
            <div>
              <label className="label" htmlFor="rec-cond">{t('record.conditions')}</label>
              <textarea id="rec-cond" rows={2} className="input" value={conditions} onChange={(e) => setConditions(e.target.value)} onBlur={() => conditions !== (d.conditions ?? '') && save.mutate({ conditions: conditions || null })} />
            </div>
          </div>
          {save.isSuccess && <p className="text-xs text-emerald-700">✓ {t('common.saved')}</p>}

          <div>
            <h3 className="label">{t('record.notes')}</h3>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate(); }}>
              <textarea rows={2} className="input" placeholder={t('record.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t('record.notes')} />
              <button className="btn-primary self-end" disabled={addNote.isPending || !note.trim()}>{t('record.addNote')}</button>
            </form>
            <ul className="mt-2 space-y-2" data-testid="record-notes">
              {d.notes.map((n) => (
                <li key={n.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="whitespace-pre-wrap">{n.body}</div>
                  <div className="mt-1 flex justify-between text-xs text-slate-500">
                    <span>{dateTime(n.createdAt)} · {n.authorName}</span>
                    {(user?.role === 'owner' || n.authorName === user?.name) && (
                      <button type="button" className="hover:text-rose-700" onClick={() => window.confirm(t('record.deleteNote')) && delNote.mutate(n.id)}>{t('common.delete')}</button>
                    )}
                  </div>
                </li>
              ))}
              {d.notes.length === 0 && <li className="text-sm text-slate-500">{t('record.noNotes')}</li>}
            </ul>
          </div>

          <div>
            <h3 className="label">{t('record.photos')}</h3>
            {!d.photosEnabled ? (
              <p className="text-xs text-slate-500">{t('record.photosOff')}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={t('record.photoKind')}>
                    {(['before', 'after', 'other'] as const).map((k) => <option key={k} value={k}>{t(`record.kind.${k}`)}</option>)}
                  </select>
                  <input className="input min-w-0 flex-1" placeholder={t('record.photoNote')} value={photoNote} onChange={(e) => setPhotoNote(e.target.value)} />
                  <button type="button" className="btn-secondary" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>{upload.isPending ? '…' : t('record.addPhoto')}</button>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                </div>
                <ErrorText error={upload.error} ns="record" />
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {d.photos.map((p) => (
                    <figure key={p.id} className="text-xs">
                      <PrivatePhoto photo={p} onOpen={setZoom} />
                      <figcaption className="mt-1 text-slate-600">
                        <b>{t(`record.kind.${p.kind}`)}</b> · {dateOnly(p.createdAt)}
                        {p.note && <span className="block text-slate-500">{p.note}</span>}
                        <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('record.deletePhoto')) && delPhoto.mutate(p.id)}>{t('common.delete')}</button>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
      <ErrorText error={rec.error} ns="record" />
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)} role="dialog">
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </section>
  );
}
