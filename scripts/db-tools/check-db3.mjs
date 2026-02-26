import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const MODEL_PREFIX = process.env.MODEL_PREFIX || 'Asl';
const db = new Database('./data/xpp-metadata.db', { readonly: true });
try {
  // Check if models matching MODEL_PREFIX are in the DB
  const models = db.prepare("SELECT model, COUNT(*) as cnt FROM symbols WHERE model LIKE ? GROUP BY model ORDER BY model").all(`${MODEL_PREFIX}%`);
  console.log(`${MODEL_PREFIX}* models in DB:`);
  if (models.length === 0) {
    console.log(`  NONE - ${MODEL_PREFIX}* models are MISSING from symbols table!`);
  } else {
    models.forEach(m => console.log(`  ${m.model}: ${m.cnt}`));
  }
} catch(e) {
  console.error('Error:', e.message, e.code);
} finally {
  db.close();
}
