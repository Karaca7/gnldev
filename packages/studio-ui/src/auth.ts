// studio-ui auth: keeps the bearer token in localStorage, adds the Authorization header to requests.
// Used while server opt-in auth (free roleAuth / paid @gnldev/auth-ee) is on; the token stays empty while it's off.
import { readLocal, writeLocal, removeLocal } from './storage';

const KEY = 'gnl-token';

// This module was the ONE place that already treated storage as fallible, and it was right. The
// guards now live in `storage.ts` so every other caller gets them too — behaviour here is unchanged.
export function getToken(): string | null {
  return readLocal(KEY);
}

export function setToken(token: string): void {
  writeLocal(KEY, token);
}

export function clearToken(): void {
  removeLocal(KEY);
}

/** Authorization (bearer) header if a token exists; empty otherwise (auth off → fetch behaves as before). */
export function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
