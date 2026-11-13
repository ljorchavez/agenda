import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { flushPending, isRegister, pendingSales, subscribe, type PendingSale } from './offlinePos';

/** The browser's idea of the connection, live. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Whether this computer is a register for the open business, and its waiting sales. */
export function useRegister() {
  const { tenant } = useAuth();
  const id = tenant?.id;
  const read = () => ({ on: isRegister(id), pending: id ? pendingSales(id) : ([] as PendingSale[]) });
  const [state, setState] = useState(read);
  useEffect(() => {
    setState(read());
    return subscribe(() => setState(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return { tenantId: id, ...state };
}

/**
 * Uploads a register's waiting sales: when the connection returns, every 20 seconds and on
 * opening. Lives in the app's layout so it works on any page, not only the point of sale.
 */
export function useOfflineSync() {
  const qc = useQueryClient();
  const { tenantId, on, pending } = useRegister();
  const online = useOnline();
  const waiting = pending.filter((p) => !p.error).length;
  useEffect(() => {
    if (!tenantId || (!on && waiting === 0)) return;
    let stop = false;
    const run = async () => {
      if (stop) return;
      const r = await flushPending(tenantId);
      if (r.sent || r.failed) {
        void qc.invalidateQueries({ queryKey: ['sales'] });
        void qc.invalidateQueries({ queryKey: ['products'] });
        void qc.invalidateQueries({ queryKey: ['payments'] });
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 20_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [tenantId, on, online, waiting, qc]);
}
