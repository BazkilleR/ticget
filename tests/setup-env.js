// Runs before config.js is loaded (in globalSetup and in every test file).
// Points the app at the separate tickets_test database so tests never touch dev data.
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/tickets_test';
  process.env.DATABASE_URL = url.toString();
}
