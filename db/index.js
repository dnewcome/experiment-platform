// Select adapter based on environment:
//
//   BigQuery:  BIGQUERY_KEYFILE=/path/to/sa.json [BIGQUERY_PROJECT=my-project] npm start
//   Postgres:  DATABASE_URL=postgres://user:pass@host:5432/dbname npm start
//   SQLite:    (default, recommended for development)

let db, label;

if (process.env.BIGQUERY_KEYFILE || process.env.BIGQUERY_PROJECT) {
  db    = (await import('./bigquery.js')).default;
  label = `project=${process.env.BIGQUERY_PROJECT ?? '(from keyfile)'} dataset=${process.env.BIGQUERY_DATASET ?? 'experiment_platform'}`;
} else if (process.env.DATABASE_URL) {
  db    = (await import('./postgres.js')).default;
  label = process.env.DATABASE_URL.replace(/:\/\/.*@/, '://<credentials>@');
} else {
  db    = (await import('./sqlite.js')).default;
  label = 'flags.db';
}

console.log(`Database: ${db.dialect} (${label})`);

export default db;
