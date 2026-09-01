// I18n setup: EN default, TR secondary — persistence follows the same pattern as the theme toggle
// (localStorage key, see App.tsx useTheme/'gnl-theme'). This file initializes as a side effect when
// Imported (once, in main.tsx); if it's imported again (e.g. in test files rendering App.tsx
// Directly) the `isInitialized` guard prevents re-init.
//
// Namespace rule (for the next wave — the agent that will extract view strings):
// Each view uses its own namespace file: locales/{en,tr}/<view>.json
//     (e.g. Inspector.tsx → 'inspector' namespace → locales/en/inspector.json + locales/tr/inspector.json)
// Inside a view: `const { t } = useTranslation('inspector');` then `t('someKey')`.
// Shared/cross-view strings (if any) go into the 'common' namespace: `useTranslation('common')`.
// Nav/governance labels stay in the 'nav' namespace (App.tsx already uses it) — view files
//     Don't write to this namespace.
// Key naming: camelCase, short and view-local (e.g. "runList", "emptyState", "confirmDelete").
// Since the namespace already identifies the view, don't re-prefix the key with the view name.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enInspector from './locales/en/inspector.json';
import enObservability from './locales/en/observability.json';
import enPlayground from './locales/en/playground.json';
import enAgents from './locales/en/agents.json';
import enTools from './locales/en/tools.json';
import enWorkflows from './locales/en/workflows.json';
import enEvals from './locales/en/evals.json';
import enJobs from './locales/en/jobs.json';
import enDeadEvents from './locales/en/deadEvents.json';
import enCache from './locales/en/cache.json';
import enScheduler from './locales/en/scheduler.json';
import enKnowledge from './locales/en/knowledge.json';
import enNetworks from './locales/en/networks.json';
import enMcp from './locales/en/mcp.json';
import enApprovals from './locales/en/approvals.json';
import enAudit from './locales/en/audit.json';
import enOrganizations from './locales/en/organizations.json';
import enUsers from './locales/en/users.json';
import enPolicy from './locales/en/policy.json';
import enPromptEditor from './locales/en/promptEditor.json';

import trCommon from './locales/tr/common.json';
import trNav from './locales/tr/nav.json';
import trInspector from './locales/tr/inspector.json';
import trObservability from './locales/tr/observability.json';
import trPlayground from './locales/tr/playground.json';
import trAgents from './locales/tr/agents.json';
import trTools from './locales/tr/tools.json';
import trWorkflows from './locales/tr/workflows.json';
import trEvals from './locales/tr/evals.json';
import trJobs from './locales/tr/jobs.json';
import trDeadEvents from './locales/tr/deadEvents.json';
import trCache from './locales/tr/cache.json';
import trScheduler from './locales/tr/scheduler.json';
import trKnowledge from './locales/tr/knowledge.json';
import trNetworks from './locales/tr/networks.json';
import trMcp from './locales/tr/mcp.json';
import trApprovals from './locales/tr/approvals.json';
import trAudit from './locales/tr/audit.json';
import trOrganizations from './locales/tr/organizations.json';
import trUsers from './locales/tr/users.json';
import trPolicy from './locales/tr/policy.json';
import trPromptEditor from './locales/tr/promptEditor.json';

export const LANG_STORAGE_KEY = 'gnl-lang';
export const SUPPORTED_LANGS = ['en', 'tr'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export function getStoredLang(): SupportedLang {
  // LocalStorage doesn't exist in a jsdom-less (node) test environment — read defensively
  // So views imported at init time (e.g. Audit) don't crash when they pull in this file.
  if (typeof localStorage === 'undefined') return 'en';
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  return stored === 'tr' ? 'tr' : 'en';
}

// Namespace list lives in one place: when adding a new view namespace, update both this and locales/{en,tr}/*.json.
const resources = {
  en: {
    common: enCommon, nav: enNav, inspector: enInspector, observability: enObservability,
    playground: enPlayground, agents: enAgents, tools: enTools, workflows: enWorkflows,
    evals: enEvals, jobs: enJobs, deadEvents: enDeadEvents, cache: enCache, scheduler: enScheduler, knowledge: enKnowledge,
    networks: enNetworks, mcp: enMcp, approvals: enApprovals, audit: enAudit,
    organizations: enOrganizations, users: enUsers, policy: enPolicy, promptEditor: enPromptEditor,
  },
  tr: {
    common: trCommon, nav: trNav, inspector: trInspector, observability: trObservability,
    playground: trPlayground, agents: trAgents, tools: trTools, workflows: trWorkflows,
    evals: trEvals, jobs: trJobs, deadEvents: trDeadEvents, cache: trCache, scheduler: trScheduler, knowledge: trKnowledge,
    networks: trNetworks, mcp: trMcp, approvals: trApprovals, audit: trAudit,
    organizations: trOrganizations, users: trUsers, policy: trPolicy, promptEditor: trPromptEditor,
  },
} as const;

if (!i18n.isInitialized) {
  i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: getStoredLang(),
      fallbackLng: 'en',
      ns: Object.keys(resources.en),
      defaultNS: 'common',
      interpolation: { escapeValue: false }, // React already escapes against XSS.
    });
}

export default i18n;
