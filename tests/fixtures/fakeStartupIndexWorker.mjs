// Stands in for startupIndexWorker.js so the parent side can be tested without
// a compiled worker: same message shapes, no database. The parent forwards
// only the real worker's fields, so the scenario rides in metadataPath
// ("scenario:<name>").
import { parentPort, workerData } from 'node:worker_threads';

const { metadataPath, modelNames } = workerData;
const scenario = String(metadataPath).replace(/^scenario:/, '');

// What the real indexer prints while it works — must reach the parent's
// chosen stream, never its stdout.
process.stdout.write(`      [100%] ${modelNames.join(', ')} indexing...\n`);
process.stderr.write('worker stderr line\n');

if (scenario === 'crash') {
  throw new Error('worker blew up before posting');
} else if (scenario === 'exit') {
  process.exit(3);
} else if (scenario === 'fail') {
  parentPort.postMessage({ type: 'error', error: 'SQLITE_BUSY: database is locked' });
} else if (scenario === 'linger') {
  // Reports, then keeps a handle open: it never exits by itself.
  parentPort.postMessage({ type: 'done', elapsedMs: 1, symbolCount: 7 });
  setInterval(() => {}, 1000);
} else if (scenario === 'late-output') {
  // The real worker closes its database after it reports, and prints while it does.
  parentPort.postMessage({ type: 'done', elapsedMs: 1, symbolCount: 7 });
  setTimeout(() => process.stderr.write('printed after the verdict\n'), 100);
} else {
  parentPort.postMessage({ type: 'done', elapsedMs: 4200, symbolCount: 1234 });
}
