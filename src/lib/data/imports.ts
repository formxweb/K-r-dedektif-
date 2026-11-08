import "server-only";
import { createClient, type Supa } from "@/lib/supabase/server";
import { readTable } from "@/lib/import/read";
import { friendlyError } from "@/lib/errors";

export interface JobRow {
  id: string;
  organization_id: string;
  kind: string;
  status: string;
  storage_path: string | null;
  file_name: string;
  params: Record<string, unknown>;
  profile_id: string | null;
}

export async function loadJob(supabase: Supa, jobId: string) {
  const { data, error } = await supabase.from("import_jobs").select("*").eq("id", jobId).single();
  if (error || !data) throw new Error("Aktarım bulunamadı.");
  return data as JobRow;
}

export async function loadJobTable(jobId: string) {
  const supabase = await createClient();
  const job = await loadJob(supabase, jobId);
  if (!job.storage_path) throw new Error("Kaynak dosya bulunamadı.");
  const { data, error } = await supabase.storage.from("imports").download(job.storage_path);
  if (error || !data) throw new Error("Kaynak dosya indirilemedi. Sayfayı yenileyin.");
  const buf = new Uint8Array(await data.arrayBuffer());
  const enc = (job.params.encoding as "utf-8" | "windows-1254" | null) ?? undefined;
  const table = readTable(buf, job.file_name, { encoding: enc ?? undefined });
  const sheet = table.sheets.find((s) => s.name === job.params.sheet) ?? table.sheets[0]!;
  return { job, table, sheet };
}


interface PreviewEntry {
  ledger_version: string;
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Kaydetme önizlemesi pahalıdır (aktarımın tamamını çalıştırıp geri sarar). Sonuç, işin
 * params.preview alanında defter sürümüyle (ledger_version) birlikte saklanır; sürüm değişmediyse
 * sayfa açılışında tekrar hesaplanmaz. Satırlar değiştiğinde server action'lar bu alanı siler.
 */
export async function getCommitPreview(
  supabase: Supa,
  job: JobRow,
  ledgerVersion: string,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const cached = job.params.preview as PreviewEntry | undefined;
  if (cached && cached.ledger_version === ledgerVersion) {
    return { result: cached.result ?? null, error: cached.error ?? null };
  }
  const r = await supabase.rpc("preview_commit", { p_job: job.id });
  const entry: PreviewEntry = r.error
    ? { ledger_version: ledgerVersion, error: friendlyError(r.error) }
    : { ledger_version: ledgerVersion, result: r.data as Record<string, unknown> };
  await supabase.from("import_jobs").update({ params: { ...job.params, preview: entry } }).eq("id", job.id).eq("status", "staged");
  return { result: entry.result ?? null, error: entry.error ?? null };
}

/** Satırlar değiştiğinde saklanan önizlemeyi geçersiz kılar. */
export async function clearCommitPreview(supabase: Supa, jobId: string): Promise<void> {
  const { data } = await supabase.from("import_jobs").select("params").eq("id", jobId).single();
  const params = { ...((data?.params ?? {}) as Record<string, unknown>) };
  if (!("preview" in params)) return;
  delete params.preview;
  await supabase.from("import_jobs").update({ params }).eq("id", jobId).eq("status", "staged");
}
