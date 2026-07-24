import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { Toaster } from './ui';
import { queryRetry } from './api';
// i18n: EN default/TR secondary setup — initializes as a side effect before render (see src/i18n/index.ts).
import './i18n';
// New design system: body/UI = Geist, data (journal key/seq/ts/code) = Geist Mono — variable, bundled, no CDN.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@xyflow/react/dist/style.css';
import './index.css';

// Bug-investigation fix #4: don't retry on 401/403 — App.tsx already falls back to a clean
// login via forceReauthIf, an unnecessary retry would only delay that reauth trigger (see src/api.ts queryRetry).
const qc = new QueryClient({ defaultOptions: { queries: { retry: queryRetry, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <HashRouter>
        <App />
        <Toaster />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
