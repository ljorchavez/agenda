import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STOCK_POLICIES, posSettingsOf, type PosSettings, type ProductDto, type StockPolicy } from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorText, Modal } from './ui';

/** The business's point-of-sale settings (the copy in the session works offline). */
export function usePosSettings() {
  const { tenant } = useAuth();
  const fallback = posSettingsOf(tenant?.settings as { pos?: PosSettings } | undefined);
  const q = useQuery({ queryKey: ['pos-settings', tenant?.id], queryFn: () => api<PosSettings>('/pos/settings'), enabled: Boolean(tenant), staleTime: 60_000 });
  return q.data ?? fallback;
}

/** Categories to choose from: the business's list plus any already on a product. */
export function useCategoryList(products: ProductDto[] | undefined) {
  const { categories } = usePosSettings();
  return useMemo(() => {
    const byKey = new Map<string, string>();
    for (const c of [...categories, ...(products ?? []).map((p) => p.category).filter((x): x is string => Boolean(x))]) {
      if (!byKey.has(c.toLocaleLowerCase('es'))) byKey.set(c.toLocaleLowerCase('es'), c);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'es'));
  }, [categories, products]);
}

/** Punto de venta → Productos → Ajustes: what happens without stock, and the categories. */
export function PosSettingsModal({ products, onClose }: { products: ProductDto[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant, setTenant } = useAuth();
  const current = usePosSettings();
  const all = useCategoryList(products);
  const [policy, setPolicy] = useState<StockPolicy>(current.stockPolicy);
  const [list, setList] = useState<string[]>(all);
  const [adding, setAdding] = useState('');
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const count = (c: string) => products.filter((p) => p.category?.toLocaleLowerCase('es') === c.toLocaleLowerCase('es')).length;
  const refresh = (v: PosSettings) => {
    qc.setQueryData(['pos-settings', tenant?.id], v);
    if (tenant) setTenant({ ...tenant, settings: { ...tenant.settings, pos: v } });
  };
  const save = useMutation({
    mutationFn: (v: { stockPolicy: StockPolicy; categories: string[] }) => api<PosSettings>('/pos/settings', { method: 'PUT', body: v }),
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: (v: { from: string; to: string | null }) => api<{ categories: string[] }>('/products/categories/rename', { method: 'POST', body: v }),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      const next = v.to ? list.map((c) => (c === v.from ? v.to! : c)) : list.filter((c) => c !== v.from);
      setList(next);
      setRenaming(null);
      refresh({ stockPolicy: policy, categories: r.categories });
    },
  });
  const add = () => {
    const name = adding.trim().slice(0, 60);
    if (!name || list.some((c) => c.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) return setAdding('');
    const next = [...list, name].sort((a, b) => a.localeCompare(b, 'es'));
    setList(next);
    setAdding('');
    save.mutate({ stockPolicy: policy, categories: next });
  };
  return (
    <Modal open title={t('pos.settings.title')} onClose={onClose} wide>
      <div className="space-y-5 text-sm" data-testid="pos-settings">
        <section>
          <h3 className="mb-1 font-semibold">{t('pos.settings.stockTitle')}</h3>
          <p className="mb-2 text-slate-600">{t('pos.settings.stockHelp')}</p>
          <div className="space-y-2">
            {STOCK_POLICIES.map((p) => (
              <label key={p} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${policy === p ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}>
                <input
                  type="radio"
                  name="stock-policy"
                  className="mt-0.5"
                  checked={policy === p}
                  onChange={() => {
                    setPolicy(p);
                    save.mutate({ stockPolicy: p, categories: list });
                  }}
                  data-testid={`stock-policy-${p}`}
                />
                <span>
                  <span className="font-medium">{t(`pos.settings.policy.${p}`)}</span>
                  <span className="block text-xs text-slate-500">{t(`pos.settings.policyHelp.${p}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-1 font-semibold">{t('pos.settings.categoriesTitle')}</h3>
          <p className="mb-2 text-slate-600">{t('pos.settings.categoriesHelp')}</p>
          <form
            className="mb-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input className="input flex-1" maxLength={60} placeholder={t('pos.settings.newCategory')} value={adding} onChange={(e) => setAdding(e.target.value)} data-testid="category-new" />
            <button className="btn-secondary" disabled={!adding.trim()} data-testid="category-add">{t('pos.settings.add')}</button>
          </form>
          {list.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-3 text-slate-500">{t('pos.settings.noCategories')}</p>
          ) : (
            <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" data-testid="category-list">
              {list.map((c) => (
                <li key={c} className="flex items-center gap-2 px-3 py-1.5">
                  {renaming?.from === c ? (
                    <form
                      className="flex flex-1 gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (renaming.to.trim() && renaming.to.trim() !== c) rename.mutate({ from: c, to: renaming.to.trim() });
                        else setRenaming(null);
                      }}
                    >
                      <input autoFocus className="input flex-1 !py-1" maxLength={60} value={renaming.to} onChange={(e) => setRenaming({ from: c, to: e.target.value })} data-testid="category-rename-input" />
                      <button className="btn-primary !py-1" disabled={rename.isPending}>{t('common.save')}</button>
                      <button type="button" className="btn-secondary !py-1" onClick={() => setRenaming(null)}>{t('common.cancel')}</button>
                    </form>
                  ) : (
                    <>
                      <span className="flex-1">{c}</span>
                      <span className="text-xs text-slate-400">{t('pos.settings.productCount', { count: count(c) })}</span>
                      <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setRenaming({ from: c, to: c })} data-testid="category-rename">{t('pos.settings.rename')}</button>
                      <button
                        type="button"
                        className="text-xs text-rose-700 hover:underline"
                        onClick={() => {
                          if (!count(c)) {
                            const next = list.filter((x) => x !== c);
                            setList(next);
                            save.mutate({ stockPolicy: policy, categories: next });
                          } else if (window.confirm(t('pos.settings.deleteConfirm', { name: c, count: count(c) }))) rename.mutate({ from: c, to: null });
                        }}
                        data-testid="category-delete"
                      >
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <ErrorText error={save.error ?? rename.error} ns="pos" />
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </Modal>
  );
}
