// Shared setup for database test files: an in-process Postgres (PGlite) with
// the Supabase pieces the migrations expect, and every migration applied.
// Mirrors the setup at the top of db.test.mjs.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

export const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  grant usage on schema public to anon, authenticated, service_role;

  -- Supabase grants EXECUTE on new public functions to these roles by
  -- default; mimic it so the tests prove the migrations' REVOKEs work.
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  create publication supabase_realtime;
`;

/** A fresh database with every migration applied, plus small helpers. */
export async function createTestDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  assert.ok(files.length >= 1, 'no migrations found');
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  const signUp = (id, email, meta = {}) =>
    db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [
      id,
      email,
      JSON.stringify(meta),
    ]);

  /** Run fn as `role` (default: a signed-in app user) with auth.uid() = uid. */
  const asRole = async (role, uid, fn) => {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  };
  const asUser = (uid, fn) => asRole('authenticated', uid, fn);
  const asService = (fn) => asRole('service_role', null, fn);

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  return { db, signUp, asUser, asService, asRole, one };
}
