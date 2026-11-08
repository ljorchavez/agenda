import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, SessionUser, TenantDto } from '@agenda/shared';
import { api, tokenStore } from './api';

interface AuthState {
  user: SessionUser | null;
  tenant: TenantDto | null;
  loading: boolean;
  setSession: (res: AuthResponse) => void;
  setTenant: (t: TenantDto) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<TenantDto | null>(null);
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));

  useEffect(() => {
    if (!tokenStore.get()) return;
    api<{ user: SessionUser; tenant: TenantDto }>('/auth/me')
      .then((r) => {
        setUser(r.user);
        setTenant(r.tenant);
      })
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  const setSession = useCallback((res: AuthResponse) => {
    tokenStore.set(res.token);
    setUser(res.user);
    setTenant(res.tenant);
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setTenant(null);
    qc.clear();
  }, [qc]);

  return (
    <AuthContext.Provider value={{ user, tenant, loading, setSession, setTenant, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
