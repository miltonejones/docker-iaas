import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { setAuthHeadersProvider } from './api';

interface AuthState {
  token: string | null;
  userId: string | null;
  email: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  getAuthHeaders: () => Record<string, string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'dockyard-auth';

function loadStoredAuth(): AuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AuthState;
  } catch { /* corrupt */ }
  return { token: null, userId: null, email: null };
}

function saveAuth(state: AuthState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>(loadStoredAuth);

  const callAuth = useCallback(async (endpoint: string, email: string, password: string) => {
    const res = await fetch(`/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Authentication failed');
    const state: AuthState = { token: data.token, userId: data.user?.id ?? null, email: data.user?.email ?? email };
    setAuth(state);
    saveAuth(state);
  }, []);

  const login = useCallback((email: string, password: string) => callAuth('login', email, password), [callAuth]);
  const register = useCallback((email: string, password: string) => callAuth('register', email, password), [callAuth]);

  const logout = useCallback(() => {
    setAuth({ token: null, userId: null, email: null });
    clearAuth();
  }, []);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
  }, [auth.token]);

  // Register synchronously so pages making API calls on first render get auth headers.
  setAuthHeadersProvider(getAuthHeaders);

  // Verify token is still valid on mount
  useEffect(() => {
    if (!auth.token) return;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${auth.token}` } })
      .then((res) => { if (!res.ok) logout(); })
      .catch(() => logout());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider value={{ ...auth, login, register, logout, getAuthHeaders }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
