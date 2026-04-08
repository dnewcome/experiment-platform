// Select adapter based on environment.
// Set DATABASE_URL to a Postgres connection string for Postgres:
//   DATABASE_URL=postgres://user:pass@host:5432/dbname npm start
// Leave unset to use SQLite (default, recommended for development).

const db = process.env.DATABASE_URL
  ? (await import('./postgres.js')).default
  : (await import('./sqlite.js')).default;

console.log(`Database: ${db.dialect}${process.env.DATABASE_URL ? ` (${process.env.DATABASE_URL.replace(/:\/\/.*@/, '://<credentials>@')})` : ' (flags.db)'}`);

export default db;
