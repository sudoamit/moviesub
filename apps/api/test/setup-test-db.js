/**
 * Jest setup (runs before every API test file): isolate database-backed tests from the app database.
 *
 * Integration suites connect via TEST_DATABASE_URL / DATABASE_URL (directly or through Nest's PrismaService)
 * and several of them delete or rewrite whole tables. Pointed at the app database, a test run wipes real
 * trades, positions, orders and bots and deactivates instruments. This guard:
 *   1. resolves the test database URL: TEST_DATABASE_URL, else DATABASE_URL with the database name suffixed `_test`;
 *   2. refuses to run unless that database name ends in `_test`;
 *   3. points BOTH TEST_DATABASE_URL and DATABASE_URL at it, so no code path can reach the app database.
 *
 * One-time setup of the test database (same server as the app database):
 *   CREATE DATABASE trading_platform_test;
 *   DATABASE_URL=<test url> npx prisma db push --schema=prisma/schema.prisma --skip-generate
 */
const fs = require('fs');
const path = require('path');

function readRootEnv(key) {
  const envPath = path.resolve(__dirname, '../../../.env');
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

function databaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function toTestUrl(url) {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = `/${name}_test`;
  return parsed.toString();
}

const explicitTestUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.DATABASE_URL || readRootEnv('DATABASE_URL');

let testUrl = explicitTestUrl;
if (!testUrl && appUrl) {
  testUrl = toTestUrl(appUrl);
}

if (testUrl) {
  const name = databaseName(testUrl);
  if (!name.endsWith('_test')) {
    throw new Error(
      `[TEST DB GUARD] Refusing to run tests against database '${name}'. ` +
        `Integration tests delete and rewrite data; TEST_DATABASE_URL must point at a database whose name ends in '_test'.`,
    );
  }
  process.env.TEST_DATABASE_URL = testUrl;
  process.env.DATABASE_URL = testUrl;
}
