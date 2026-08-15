// Child process (run via tsx): starts a run and signals the parent the moment the model call is
// in flight — then WAITS to be SIGKILLed. No exit handler, no catch block, no cleanup: the point is
// that NOTHING after the kill runs, which is exactly the window where status used to lie.
import { writeFileSync } from 'node:fs';
import { runDurable } from '../../src/run.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { armFixtureWatchdog } from './watchdog.js';

armFixtureWatchdog(); // never outlive the test that spawned this — see watchdog.ts

const dbPath = process.argv[2]!;
const readyPath = process.argv[3]!;

const model: any = {
  specificationVersion: 'v2',
  provider: 'mock',
  modelId: 'mock',
  supportedUrls: {},
  doGenerate: () => {
    // Mid-work, journal already carries the write-ahead. Tell the parent, then hang until the kill.
    writeFileSync(readyPath, 'mid-flight');
    return new Promise(() => { /* SIGKILL lands here */ });
  },
  doStream: async () => { throw new Error('generate-only'); },
};

const journal = new SqliteStorage(dbPath).runs;
void runDurable({ runId: 'victim', journal, model, prompt: 'work that will be interrupted' } as any);
