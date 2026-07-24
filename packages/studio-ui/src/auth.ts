// studio-ui auth: keeps the bearer token in localStorage, adds the Authorization header to requests.
// Used while server opt-in auth (free roleAuth / paid @gnl/auth-ee) is on; the token stays empty while it's off.
const KEY = 'gnl-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Authorization (bearer) header if a token exists; empty otherwise (auth off → fetch behaves as before). */
export function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
