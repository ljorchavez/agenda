import { setPatientWords } from '../i18n';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isHealthType, type AuthResponse, type BusinessSummary, type SessionUser, type TenantDto } from '@agenda/shared';
import { api, sessionHint } from './api';
import { forgetCopies, isNetworkError, loadSession, markOnline, saveSession } from './offlinePos';

interface AuthState {
  user: SessionUser | null;
  tenant: TenantDto | null;
  loading: boolean;
  setSession: (res: AuthResponse) => void;
  setTenant: (t: TenantDto) => void;
  setUser: (u: SessionUser) => void;
  /** Businesses this login can open */
  businesses: BusinessSummary[];
  /** Opens another business (new token; cached data is dropped) */
  switchBusiness: (tenantId: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<TenantDto | null>(null);
  const [loading, setLoading] = useState(sessionHint.get());
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  // Health businesses talk about "pacientes". Set while rendering (not in an effect) so the
  // children of this render, menu included, already use the right word.
  setPatientWords(Boolean(tenant && isHealthType(tenant.businessType)));

  useEffect(() => {
    if (!sessionHint.get()) return;
    api<{ user: SessionUser; tenant: TenantDto; businesses: BusinessSummary[] }>('/auth/me')
      .then((r) => {
        // An old saved token has just been moved to the cookie: forget it.
        if (sessionHint.legacyToken()) {
          sessionHint.dropLegacy();
          sessionHint.set();
        }
        setUser(r.user);
        setTenant(r.tenant);
        setBusinesses(r.businesses ?? []);
        // A register keeps the session to open without internet
        saveSession({ user: r.user, tenant: r.tenant, businesses: r.businesses ?? [] });
        markOnline(r.tenant.id);
      })
      .catch((e) => {
        // No internet on a register: open with the saved session (the point of sale keeps working)
        const saved = isNetworkError(e) ? loadSession() : null;
        if (saved) {
          setUser(saved.user);
          setTenant(saved.tenant);
          setBusinesses(saved.businesses);
          return;
        }
        if (!isNetworkError(e)) sessionHint.clear();
      })
      .finally(() => setLoading(false));
  }, []);

  const setSession = useCallback((res: AuthResponse) => {
    sessionHint.dropLegacy();
    sessionHint.set();
    qc.clear();
    setUser(res.user);
    setTenant(res.tenant);
    setBusinesses(res.businesses ?? []);
  }, [qc]);

  const switchBusiness = useCallback(async (tenantId: string) => {
    setSession(await api<AuthResponse>('/auth/switch', { method: 'POST', body: { tenantId } }));
  }, [setSession]);

  const logout = useCallback(() => {
    // Business data copied on a register goes; sales waiting to upload stay (money already taken)
    if (tenant) forgetCopies(tenant.id);
    sessionHint.clear();
    void api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    setTenant(null);
    setBusinesses([]);
    qc.clear();
  }, [qc, tenant]);

  return (
    <AuthContext.Provider value={{ user, tenant, loading, setSession, setTenant, setUser, businesses, switchBusiness, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * Mirrors the API's access rules (lib/access.ts):
 * - manager: owner or admin, sees and manages everything
 * - scoped: a colaborador linked to a resource, who only sees its bookings
 */
export function useAccess() {
  const { user } = useAuth();
  const manager = user?.role === 'owner' || user?.role === 'admin';
  const resourceId = user?.resourceId ?? null;
  /** Logins linked to a resource (barber, instructor) see only its bookings; front desk sees all. */
  const scoped = !manager && Boolean(resourceId);
  /** Location this login is limited to (gerente de sucursal, host), or null */
  const locationId = user?.role === 'owner' ? null : user?.locationId ?? null;
  return {
    manager,
    /** Can change business-wide things: settings, services, locations */
    businessManager: manager && !locationId,
    scoped,
    resourceId,
    locationId,
  };
}
