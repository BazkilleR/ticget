import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, request } from '../api/client';

const STORAGE_KEY = 'ticket.auth';
const AuthContext = createContext(null);

// sessionStorage, not localStorage: the token (1 h, HS256) dies with the tab. Storage can throw in private
// windows, so every access is guarded and the app still works logged-out.
function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    if (saved && tokenExpiry(saved.token) > Date.now()) return saved;
  } catch {
    // ignore: treat as logged out
  }
  return null;
}

function save(value) {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore: session just will not survive a reload
  }
}

// Reads exp from the JWT payload only to log out on time. The signature is the server's job.
function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).exp * 1000;
  } catch {
    return 0;
  }
}

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(load);

  const logout = useCallback(() => {
    save(null);
    setAuth(null);
  }, []);

  const login = useCallback(async (username, password) => {
    const { token } = await request('/auth/login', { method: 'POST', body: { username, password } });
    const value = { token, username };
    save(value);
    setAuth(value);
  }, []);

  useEffect(() => {
    if (!auth) return undefined;
    const ms = tokenExpiry(auth.token) - Date.now();
    // setTimeout overflows above ~24.8 days; tokens live 1 h so this is only a guard.
    const timer = setTimeout(logout, Math.min(Math.max(ms, 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [auth, logout]);

  const value = useMemo(
    () => ({ token: auth?.token ?? null, username: auth?.username ?? null, login, logout }),
    [auth, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

// request() bound to the current token. A 401 on an authenticated call means the token is no longer
// accepted, so drop it and let ProtectedRoute send the user to the login page.
export function useApi() {
  const { token, logout } = useAuth();
  return useCallback(
    async (path, options = {}) => {
      try {
        return await request(path, { ...options, token });
      } catch (err) {
        if (token && err instanceof ApiError && err.status === 401) logout();
        throw err;
      }
    },
    [token, logout],
  );
}
