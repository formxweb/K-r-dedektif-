import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const DB_URL = process.env.KD_TEST_DB_URL ?? "postgresql://postgres@127.0.0.1:54329/kd_test";

export function resetDatabase(): void {
  execFileSync(path.resolve(__dirname, "reset-db.sh"), { stdio: "pipe" });
}

export async function adminClient(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  // numeric değerleri metin olarak al (hassasiyet kaybı olmasın)
  c.setTypeParser(1700, (v) => v);
  await c.connect();
  return c;
}

export async function createUser(admin: Client, email: string): Promise<string> {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

/** Sorguyu Supabase'deki gibi "authenticated" rolüyle ve verilen kullanıcının JWT'siyle çalıştırır. */
export async function asUser<T>(admin: Client, userId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  await admin.query("begin");
  try {
    await admin.query("set local role authenticated");
    await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const result = await fn(makeQ(admin));
    await admin.query("commit");
    return result;
  } catch (e) {
    await admin.query("rollback");
    throw e;
  }
}

export type Q = <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

function makeQ(c: Client): Q {
  return async (sql, params) => (await c.query(sql, params)).rows;
}

export async function one<R extends Record<string, unknown>>(q: Q, sql: string, params?: unknown[]): Promise<R> {
  const rows = await q<R>(sql, params);
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}: ${sql}`);
  return rows[0]!;
}

export function fakeHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Hazırlanmış (staged) bir aktarım işi ve satırları oluşturur — sunucu tarafının yaptığı gibi. */
export async function stageJob(
  q: Q,
  org: string,
  kind: string,
  params: Record<string, unknown>,
  rows: Array<{ parsed: Record<string, unknown>; product_id?: string | null; status?: string }>,
  seed?: string,
): Promise<string> {
  const job = await one<{ id: string }>(
    q,
    `insert into public.import_jobs (organization_id, kind, file_name, file_hash, params, row_count, ok_count)
     values ($1, $2, $3, $4, $5, $6, $6) returning id`,
    [org, kind, `${kind}.csv`, fakeHash(seed ?? randomUUID()), JSON.stringify(params), rows.length],
  );
  let n = 1;
  for (const r of rows) {
    await q(
      `insert into public.import_rows (organization_id, job_id, row_number, raw, parsed, status, product_id)
       values ($1, $2, $3, '{}'::jsonb, $4, $5, $6)`,
      [org, job.id, n++, JSON.stringify(r.parsed), r.status ?? "ok", r.product_id ?? null],
    );
  }
  return job.id;
}

export async function commit(q: Q, jobId: string): Promise<Record<string, unknown>> {
  const r = await one<{ r: Record<string, unknown> }>(q, "select public.commit_import($1, null) as r", [jobId]);
  return r.r;
}

export async function revert(q: Q, jobId: string, reason = "test geri alma"): Promise<Record<string, unknown>> {
  const r = await one<{ r: Record<string, unknown> }>(q, "select public.revert_import($1, $2, null) as r", [jobId, reason]);
  return r.r;
}

export async function setupOrg(admin: Client, name: string): Promise<{ user: string; org: string }> {
  const user = await createUser(admin, `${name.toLowerCase().replace(/\s+/g, "")}-${randomUUID().slice(0, 6)}@test.local`);
  const org = await asUser(admin, user, async (q) => (await one<{ id: string }>(q, "select public.create_organization($1) as id", [name])).id);
  return { user, org };
}

export async function createProduct(
  q: Q,
  org: string,
  name: string,
  opts: { barcode?: string; base_unit?: string; vat?: string } = {},
): Promise<string> {
  // Ürünler normalde ürün listesi aktarımıyla gelir; test için aktarım kullanıyoruz.
  const jobId = await stageJob(q, org, "product_list", { stock_date: "2026-09-30" }, [
    { parsed: { name, barcode: opts.barcode ?? null, base_unit: opts.base_unit ?? "adet", vat_rate: opts.vat ?? "1" } },
  ]);
  await commit(q, jobId);
  const p = await one<{ id: string }>(q, "select id from public.products where organization_id = $1 and name = $2", [org, name]);
  return p.id;
}

export function d(s: string | null | undefined): string | null {
  return s === null || s === undefined ? null : s;
}

/** Beklenen hatayı savepoint içinde dener; işlem (transaction) kullanılmaya devam edebilir. */
export async function rejects(q: Q, fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  await q("savepoint expect_fail");
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  await q("rollback to savepoint expect_fail");
  if (!err) throw new Error(`hata bekleniyordu: ${re}`);
  const msg = String((err as Error).message);
  if (!re.test(msg)) throw new Error(`beklenmeyen hata: ${msg} (beklenen ${re})`);
}
