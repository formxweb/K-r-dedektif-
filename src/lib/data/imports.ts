import "server-only";
import { createClient, type Supa } from "@/lib/supabase/server";
import { readTable } from "@/lib/import/read";

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

