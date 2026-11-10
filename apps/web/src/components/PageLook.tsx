import { useTranslation } from 'react-i18next';
import type { PageSettings } from '@agenda/shared';
import { GalleryInput, PhotoInput } from './Photo';

type Page = PageSettings & { gallery: string[] };

/** Banner, profile picture, gallery, social links and notice of the public booking page. */
export function PageLookSection({ value, onChange, disabled, name, slug }: { value: Page; onChange: (p: Page) => void; disabled: boolean; name: string; slug: string }) {
  const { t } = useTranslation();
  const set = (patch: Partial<Page>) => onChange({ ...value, ...patch });
  return (
    <section className="card space-y-4" id="pagina">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('page.title')}</h2>
          <p className="text-sm text-slate-500">{t('page.help')}</p>
        </div>
        <a href={`/b/${slug}`} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-medium text-brand-700 hover:underline">{t('page.view')} ↗</a>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <PhotoInput label={t('page.banner')} shape="wide" maxSide={1600} name={name} value={value.bannerUrl ?? null} onChange={(u) => set({ bannerUrl: u })} />
        <PhotoInput label={t('page.logo')} name={name} value={value.logoUrl ?? null} onChange={(u) => set({ logoUrl: u })} />
      </div>
      <GalleryInput value={value.gallery} onChange={(g) => set({ gallery: g })} disabled={disabled} />
      <div className="grid gap-3 sm:grid-cols-3">
        {(['instagram', 'facebook', 'tiktok'] as const).map((n) => (
          <div key={n}>
            <label className="label" htmlFor={`pg-${n}`}>{t(`page.${n}`)}</label>
            <input id={`pg-${n}`} className="input" placeholder="@tunegocio" disabled={disabled} value={value[n] ?? ''} onChange={(e) => set({ [n]: e.target.value || null })} />
          </div>
        ))}
      </div>
      <div>
        <label className="label" htmlFor="pg-notice">{t('page.notice')}</label>
        <input id="pg-notice" className="input" maxLength={200} placeholder={t('page.noticePlaceholder')} disabled={disabled} value={value.notice ?? ''} onChange={(e) => set({ notice: e.target.value || null })} />
      </div>
    </section>
  );
}
