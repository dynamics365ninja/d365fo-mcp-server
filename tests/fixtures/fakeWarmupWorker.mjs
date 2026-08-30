// Stands in for indexWarmupWorker.js so the parent side can be tested without a
// compiled worker: same message shapes, no database.
import { parentPort, workerData } from 'node:worker_threads';

parentPort.postMessage({ type: 'step', name: 'symbols.idx_symbols_name', ms: 8000, rows: 10 });
parentPort.postMessage({ type: 'error', name: 'labels_fts', error: 'no such table: labels_fts' });
parentPort.postMessage({ type: 'step', name: 'labels join label_files', ms: 3000, rows: 5 });
parentPort.postMessage({ type: 'done', totalMs: 11000, budgetSeen: workerData.budgetMs });
