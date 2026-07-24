// Runtime config: @gnl/studio injects `window.__GNL_STUDIO__` into index.html (apiBase + capabilities).
// No injection in dev (vite) → '/api' (the vite proxy forwards to GNL_STUDIO_API).
export interface StudioConfig {
  apiBase: string;
}

const injected = (globalThis as unknown as { __GNL_STUDIO__?: Partial<StudioConfig> }).__GNL_STUDIO__;

export const config: StudioConfig = {
  apiBase: injected?.apiBase ?? '/api',
};
