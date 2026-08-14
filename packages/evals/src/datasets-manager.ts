// DatasetsManager — dataset VERSION HISTORY + experiment
// Records + experiment COMPARISON (regression/improvement deltas). Journal-based → persistence comes
// Free from the storage layer, and the studio can read from the same journal.
//
// Key schema (':' is FORBIDDEN in ids so they stay invisible to parseJournalKey — validated below):
//   Ds:def:<dsId>:v<N>      → the Nth version of the dataset definition ({ dataset, at, hash })
//   Ds:def:<dsId>:latest    → { version: N }
//   Ds:exp:<dsId>:<expId>   → experiment record ({ result, at, label, datasetVersion })
import { claim, stableStringify } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import type { Scorer } from './scorer.js';
import { evalDataset } from './dataset.js';
import type { Dataset, EvalRunner, EvalDatasetResult } from './dataset.js';

export interface DatasetVersion {
  version: number;
  at: number;
  dataset: Dataset;
}

export interface ExperimentRecord {
  id: string;
  datasetId: string;
  /** The dataset version the experiment ran against (latest at the time). */
  datasetVersion: number;
  at: number;
  /** Free-form label (e.g. 'gpt-4o + new-prompt'). */
  label?: string;
  result: EvalDatasetResult;
}

export interface ExperimentDiff {
  datasetId: string;
  baseline: string;
  candidate: string;
  /** Scorer name → total (average) delta. */
  aggregate: Record<string, { baseline: number; candidate: number; delta: number }>;
  /** (case, scorer) pairs whose score CHANGED (delta = candidate - baseline). */
  changes: { caseId: string; scorer: string; baseline: number; candidate: number; delta: number }[];
  regressions: number;
  improvements: number;
}

const ID_RE = /^[^:\s]+$/; // ':' is the journal key separator; whitespace is also forbidden for readability
function assertId(kind: string, id: string): void {
  if (!ID_RE.test(id)) throw new Error(`@gnldev/evals DatasetsManager: ${kind} id cannot contain ':' or whitespace ('${id}')`);
}

export interface RunExperimentOptions {
  dataset?: Dataset; // if given, saveDataset (versioning) runs first
  datasetId?: string; // if given, the latest saved version is used
  run: EvalRunner;
  scorers: Scorer[];
  /** Experiment id (time-based if not given). The SAME id is not run a second time — returns the saved result (idempotent). */
  experimentId?: string;
  label?: string;
  /** For testability: "now" (default Date.now). */
  now?: number;
}

/**
 * Journal-based dataset/experiment manager. Requires a journal that supports `listKeys`
 * (the InMemory/SQLite/Postgres/Redis adapters provide it).
 */
export function createDatasetsManager(journal: Journal) {
  const requireListKeys = () => {
    if (typeof journal.listKeys !== 'function') {
      throw new Error("@gnldev/evals DatasetsManager: journal does not support 'listKeys'");
    }
    return journal.listKeys.bind(journal);
  };

  /** Save a versioned dataset: if the content is UNCHANGED, no new version is opened (hash comparison). */
  async function saveDataset(dataset: Dataset, now: number = Date.now()): Promise<DatasetVersion> {
    assertId('dataset', dataset.id);
    const hash = stableStringify(dataset);
    const latest = await journal.get<{ version: number }>(`ds:def:${dataset.id}:latest`);
    if (latest) {
      const cur = await journal.get<{ dataset: Dataset; at: number; hash: string }>(`ds:def:${dataset.id}:v${latest.version}`);
      if (cur && cur.hash === hash) return { version: latest.version, at: cur.at, dataset: cur.dataset };
    }
    const version = (latest?.version ?? 0) + 1;
    await journal.put(`ds:def:${dataset.id}:v${version}`, { dataset, at: now, hash });
    await journal.put(`ds:def:${dataset.id}:latest`, { version });
    return { version, at: now, dataset };
  }

  async function getDataset(dsId: string, version?: number): Promise<DatasetVersion | undefined> {
    const v = version ?? (await journal.get<{ version: number }>(`ds:def:${dsId}:latest`))?.version;
    if (v == null) return undefined;
    const rec = await journal.get<{ dataset: Dataset; at: number }>(`ds:def:${dsId}:v${v}`);
    return rec ? { version: v, at: rec.at, dataset: rec.dataset } : undefined;
  }

  /** All versions of a dataset (ascending). */
  async function listVersions(dsId: string): Promise<{ version: number; at: number; cases: number }[]> {
    const keys = await requireListKeys()(`ds:def:${dsId}:v`);
    const out: { version: number; at: number; cases: number }[] = [];
    for (const k of keys) {
      const v = Number(k.slice(`ds:def:${dsId}:v`.length));
      if (!Number.isFinite(v)) continue;
      const rec = await journal.get<{ dataset: Dataset; at: number }>(k);
      if (rec) out.push({ version: v, at: rec.at, cases: rec.dataset.cases.length });
    }
    return out.sort((a, b) => a.version - b.version);
  }

  /**
   * Run and record an experiment. If `experimentId` is given, it's IDEMPOTENT: a second call with the
   * Same id does NOT re-run evalDataset, it returns the saved result (evalDataset's own
   * Case-memoization is already journaled; this layer also deduplicates the experiment META record).
   */
  async function runExperiment(opts: RunExperimentOptions): Promise<ExperimentRecord> {
    const now = opts.now ?? Date.now();
    let dsv: DatasetVersion | undefined;
    if (opts.dataset) dsv = await saveDataset(opts.dataset, now);
    else if (opts.datasetId) dsv = await getDataset(opts.datasetId);
    if (!dsv) throw new Error('@gnldev/evals DatasetsManager: dataset not found (give a dataset or a saved datasetId)');

    const expId = opts.experimentId ?? `e${now.toString(36)}`;
    assertId('experiment', expId);
    const key = `ds:exp:${dsv.dataset.id}:${expId}`;
    const existing = await journal.get<ExperimentRecord>(key);
    if (existing) return existing;

    // Scope = dataset+experiment: DIFFERENT experiments on the same dataset don't see each other's
    // Memoized cases; a crash-resume of the SAME experiment does (resumable suite is preserved).
    const result = await evalDataset({ dataset: dsv.dataset, run: opts.run, scorers: opts.scorers, journal, scope: `${dsv.dataset.id}:exp:${expId}` });
    const rec: ExperimentRecord = {
      id: expId, datasetId: dsv.dataset.id, datasetVersion: dsv.version, at: now,
      ...(opts.label ? { label: opts.label } : {}), result,
    };
    if (!(await claim(journal, key, rec))) return (await journal.get<ExperimentRecord>(key))!; // winner of the race
    return rec;
  }

  async function getExperiment(dsId: string, expId: string): Promise<ExperimentRecord | undefined> {
    return journal.get<ExperimentRecord>(`ds:exp:${dsId}:${expId}`);
  }

  /** A dataset's experiments (ascending by time). */
  async function listExperiments(dsId: string): Promise<{ id: string; at: number; label?: string; datasetVersion: number; aggregate: Record<string, number> }[]> {
    const prefix = `ds:exp:${dsId}:`;
    const keys = await requireListKeys()(prefix);
    const out: { id: string; at: number; label?: string; datasetVersion: number; aggregate: Record<string, number> }[] = [];
    for (const k of keys) {
      const rec = await journal.get<ExperimentRecord>(k);
      if (rec) out.push({ id: rec.id, at: rec.at, label: rec.label, datasetVersion: rec.datasetVersion, aggregate: rec.result.aggregate });
    }
    return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }

  /** Compare two experiments: aggregate deltas + (case, scorer) pairs whose score changed. */
  async function compare(dsId: string, baselineId: string, candidateId: string): Promise<ExperimentDiff> {
    const [base, cand] = await Promise.all([getExperiment(dsId, baselineId), getExperiment(dsId, candidateId)]);
    if (!base || !cand) throw new Error(`@gnldev/evals DatasetsManager: experiment not found ('${!base ? baselineId : candidateId}')`);

    const aggregate: ExperimentDiff['aggregate'] = {};
    for (const name of new Set([...Object.keys(base.result.aggregate), ...Object.keys(cand.result.aggregate)])) {
      const b = base.result.aggregate[name] ?? 0;
      const c = cand.result.aggregate[name] ?? 0;
      aggregate[name] = { baseline: b, candidate: c, delta: c - b };
    }

    const baseCases = new Map(base.result.cases.map((c) => [c.caseId, c]));
    const changes: ExperimentDiff['changes'] = [];
    for (const cc of cand.result.cases) {
      const bc = baseCases.get(cc.caseId);
      if (!bc) continue; // new case → delta is meaningless (aggregate already reflects it)
      for (const scorer of Object.keys(cc.scores)) {
        const b = bc.scores[scorer]?.score ?? 0;
        const c = cc.scores[scorer]?.score ?? 0;
        if (b !== c) changes.push({ caseId: cc.caseId, scorer, baseline: b, candidate: c, delta: c - b });
      }
    }
    changes.sort((a, b) => a.delta - b.delta); // worst regression first
    return {
      datasetId: dsId, baseline: baselineId, candidate: candidateId, aggregate, changes,
      regressions: changes.filter((c) => c.delta < 0).length,
      improvements: changes.filter((c) => c.delta > 0).length,
    };
  }

  return { saveDataset, getDataset, listVersions, runExperiment, getExperiment, listExperiments, compare };
}
