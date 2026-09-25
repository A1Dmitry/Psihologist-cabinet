/**
 * tools/dbtest — тестовая обвязка, поднимающая НАСТОЯЩИЙ PostgreSQL и применяющая
 * к нему `supabase/schema.sql` дословно.
 *
 * Зачем: смоук-скрипты проекта мокают `fetch`, поэтому SQL-контракт (RPC
 * create_booking / claim_psychologist_profile, RLS, ограничения) до этого не
 * проверялся ничем. Здесь проверяется именно он — без второй реализации логики:
 * исполняется тот же файл схемы, что деплоится в прод.
 *
 * Обвязка воспроизводит только то окружение, которое в Supabase уже есть:
 *   роли anon / authenticated / service_role,
 *   схема auth (auth.users) и функция auth.uid() из JWT-claim,
 *   GUC request.jwt.claim.sub, который ставит PostgREST.
 * Это НЕ продуктовый код и в сборку сайта не попадает.
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Окружение Supabase, которого нет в чистом Postgres. */
const SUPABASE_ENV = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

-- Поля GoTrue, нужные контуру OAuth/Google (добавлены 2026-09-25):
--   email_confirmed_at  — отметка подтверждения email (GoTrue ставит её сам
--                         для OAuth-провайдеров, подтвердивших email);
--   raw_user_meta_data  — данные провайдера (full_name, name, picture, …).
-- Аддитивно: существующие наборы создают пользователей как раньше.
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}'::jsonb;

-- auth.uid() в Supabase — это sub из JWT, который PostgREST кладёт в GUC.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Базовые гранты Supabase: в реальном проекте они выдаются default privileges,
-- а дальше RLS-политики решают, какие именно строки видны. schema.sql при этом
-- явно отзывает доступ у anon там, где он не нужен (revoke all ... from anon).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export class TestDatabase {
  constructor({
    // случайный порт: параллельные/повторные запуски не должны ловить EADDRINUSE
    port = 55000 + Math.floor(Math.random() * 1000),
    dataDir = join(ROOT, '.pgdata')
  } = {}) {
    this.port = port;
    this.dataDir = dataDir;
    this.pg = null;
    this.pool = null;
  }

  async start() {
    // embedded-postgres с persistent:false сам чистит каталог при остановке, но
    // после аварийного завершения прошлый запуск может оставить данные — тогда
    // initdb отказывается работать. Чистим сами: это одноразовая тестовая БД.
    await rm(this.dataDir, { recursive: true, force: true });
    this.pg = new EmbeddedPostgres({
      databaseDir: this.dataDir,
      user: 'postgres',
      password: 'postgres',
      port: this.port,
      persistent: false,
      // без явного UTF8 initdb берёт кодировку из локали песочницы (SQL_ASCII),
      // и кириллица в данных падает с «invalid byte sequence for encoding»
      initdbFlags: ['--encoding=UTF8']
    });
    await this.pg.initialise();
    await this.pg.start();
    this.pool = new pg.Pool({
      host: '127.0.0.1',
      port: this.port,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
      // Poka-Yoke (recovery PR32, D1-QG-004): без таймаутов коннект/
      // запрос к чёрной дыре (чужой процесс на порту, зависший PG)
      // ждёт вечно и вешает гейт. Таймауты превращают вис в rejection →
      // catch-fatal → красный детерминированный выход. Запасы щедрые:
      // обычные запросы наборов — миллисекунды.
      connectionTimeoutMillis: 15000,
      query_timeout: 120000,
      statement_timeout: 120000
    });
    await this.pool.query(SUPABASE_ENV);
    return this;
  }

  /** Применить supabase/schema.sql (и, опционально, seed.sql) дословно. */
  async applySchema({ seed = false } = {}) {
    const schema = await readFile(join(ROOT, 'supabase', 'schema.sql'), 'utf8');
    await this.pool.query(schema);
    if (seed) {
      const seedSql = await readFile(join(ROOT, 'supabase', 'seed.sql'), 'utf8');
      await this.pool.query(seedSql);
    }
    return this;
  }

  async stop() {
    if (this.pool) await this.pool.end().catch(() => {});
    this.pool = null;
    if (this.pg) await this.pg.stop().catch(() => {});
    this.pg = null;
  }

  /** Запрос от имени роли PostgREST. uid — sub из JWT (для authenticated). */
  async query(sql, params = [], { role = 'service_role', uid = null } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      if (uid) {
        await client.query(`set local request.jwt.claim.sub = '${uid}'`);
      } else {
        await client.query(`set local request.jwt.claim.sub = ''`);
      }
      const res = await client.query(sql, params);
      await client.query('commit');
      return res.rows;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Отдельное соединение, живущее внутри одной транзакции — нужно, чтобы
   * проверить гонку двух параллельных записей на один слот.
   */
  async transaction({ role = 'authenticated', uid = null } = {}) {
    const client = await this.pool.connect();
    await client.query('begin isolation level read committed');
    await client.query(`set local role ${role}`);
    await client.query(`set local request.jwt.claim.sub = ${uid ? `'${uid}'` : "''"}`);
    return {
      query: (sql, params) => client.query(sql, params).then(r => r.rows),
      commit: async () => { await client.query('commit'); client.release(); },
      rollback: async () => { await client.query('rollback').catch(() => {}); client.release(); }
    };
  }

  /**
   * Создать пользователя Supabase Auth (в проде это делает GoTrue).
   * Выполняется от суперпользователя, без переключения роли: auth.users —
   * служебная таблица GoTrue, PostgREST-роли к ней доступа не имеют.
   */
  /**
   * Создать пользователя Supabase Auth (в проде это делает GoTrue).
   * Выполняется от суперпользователя, без переключения роли: auth.users —
   * служебная таблица GoTrue, PostgREST-роли к ней доступа не имеют.
   *
   * @param {string} email
   * @param {{confirmed?: boolean, meta?: object}} [opts] — email_confirmed_at и
   *        raw_user_meta_data. По умолчанию confirmed=true (старое поведение);
   *        контур Google проверяет и неподтверждённый email, и имя провайдера.
   */
  async createAuthUser(email, { confirmed = true, meta = {} } = {}) {
    const rows = await this.pool.query(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
       values ($1, $2, $3::jsonb) returning id`,
      [
        String(email).toLowerCase().trim(),
        confirmed ? new Date().toISOString() : null,
        JSON.stringify(meta || {})
      ]
    );
    return rows.rows[0].id;
  }

  /** Применить дополнительный SQL-файл (например, миграцию из supabase/migrations). */
  async applySqlFile(relPath) {
    const sql = await readFile(join(ROOT, relPath), 'utf8');
    await this.pool.query(sql);
    return this;
  }

  /** RPC от имени пользователя (как PostgREST /rpc/<fn>). */
  rpc(fn, args, { uid = null, role = 'authenticated' } = {}) {
    const names = Object.keys(args);
    const sql = `select ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`;
    return this.query(sql, Object.values(args), { role, uid }).then(r => r[0]?.result);
  }

  async count(table, where = '', params = []) {
    const rows = await this.query(`select count(*)::int as n from ${table} ${where}`, params);
    return rows[0].n;
  }
}

/** Поднять БД, применить схему, вернуть handle. */
export async function startTestDatabase(opts = {}) {
  const db = new TestDatabase(opts);
  await db.start();
  await db.applySchema(opts);
  return db;
}

/**
 * startTestDatabase с детерминированным провалом: если БД не поднялась,
 * выйти с кодом 2 СРАЗУ. Без этого стартовый throw уходил в
 * unhandledRejection (exitCode=1), а async-exit-hook форсил exit 0 —
 * набор «проходил», не выполнив ни одной проверки (дыра найдена
 * parity-набором при recovery PR32, D1-QG-004).
 */
export async function startTestDatabaseOrExit(opts = {}) {
  try {
    return await startTestDatabase(opts);
  } catch (e) {
    console.error('FATAL: cannot start test database:', e?.message ?? e ?? '(no reason given)');
    await new Promise(r => setTimeout(r, 100));
    process.exit(2);
  }
}

/**
 * Завершить DB-набор с детерминированным кодом выхода.
 *
 * Почему нельзя `process.exitCode = …` + естественный выход: embedded-postgres
 * тянет зависимость async-exit-hook, которая перехватывает событие `beforeExit`
 * и завершает процесс кодом 0 ВНЕ зависимости от process.exitCode — провалы
 * проверок маскировались под успех (найдено Challenger-аудитом D1 2026-09-24:
 * форсированный FAIL в db-contract печатал FAILED, но выходил с кодом 0).
 * Явный process.exit() событие beforeExit НЕ триггерит, поэтому код выхода
 * сохраняется. Пауза 100 мс — чтобы pipe stdout успел сбросить последние
 * строки (process.exit может обрезать асинхронные записи в pipe).
 *
 * @param {number|Array} failedCount — число проваленных проверок (0 = успех)
 *   либо массив провалов. Код выхода также учитывает `process.exitCode`,
 *   выставленный обработчиками uncaughtException/unhandledRejection:
 *   иначе stray async-крах печатается, но `exit(0)` затирает красный код
 *   (issue #36 / канал A).
 */
export async function finishSuite(failedCount) {
  const n = Array.isArray(failedCount) ? failedCount.length : Number(failedCount);
  const fromResults = Number.isFinite(n) && n > 0 ? 1 : 0;
  const codeNow = () => (fromResults || process.exitCode) ? 1 : 0;
  process.exitCode = codeNow();
  await new Promise(r => setTimeout(r, 100));
  process.exit(codeNow());
}
