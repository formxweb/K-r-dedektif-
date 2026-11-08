"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient, type Supa } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";
import { friendlyError, type ActionState } from "@/lib/errors";
import { readTable, decodeText, MAX_FILE_BYTES } from "@/lib/import/read";
import { detectHeaderRow, headersAt, headerSignature } from "@/lib/import/header";
import { FIELDS, missingRequired } from "@/lib/import/fields";
import { transformInvoiceTable, transformRows, type ProfileOptions, type StagedRow } from "@/lib/import/transform";
import { parseUblInvoice, UblError } from "@/lib/import/ubl";
import { fetchAll, loadProducts, loadVatLookup } from "@/lib/data/common";
import { clearCommitPreview, loadJob, loadJobTable } from "@/lib/data/imports";
import { isIsoDate } from "@/lib/domain/dates";

const TABLE_KINDS = ["product_list", "sales_summary", "sales_receipts", "purchase_invoice_table"] as const;
type TableKind = (typeof TABLE_KINDS)[number];

function withoutPreview(p: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...p };
  delete rest.preview;
  return rest;
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-120);
  return base || "dosya";
}

async function existingJobWithHash(supabase: Supa, orgId: string, kind: string, hash: string) {
  const { data } = await supabase
    .from("import_jobs")
    .select("id, status, file_name, created_at")
    .eq("organization_id", orgId)
    .eq("kind", kind)
    .eq("file_hash", hash)
    .in("status", ["staged", "committed"])
    .maybeSingle();
  return data;
}

const UPLOAD_EXT: Record<string, RegExp> = {
  purchase_invoice_xml: /\.xml$/i,
  product_list: /\.(xls|xlsx|csv|txt)$/i,
  sales_summary: /\.(xls|xlsx|csv|txt)$/i,
  sales_receipts: /\.(xls|xlsx|csv|txt)$/i,
  purchase_invoice_table: /\.(xls|xlsx|csv|txt)$/i,
};

export interface UploadPlanResult {
  ok?: boolean;
  error?: string;
  uploads?: Array<{ path: string; token: string }>;
}

export interface UploadRegisterResult {
  ok?: boolean;
  error?: string;
  message?: string;
  redirect?: string;
  dupJobId?: string;
}

const FALLBACK_MAX_BYTES = 4 * 1024 * 1024;

const fileMetaSchema = z.object({ name: z.string().min(1).max(255), size: z.number().int().nonnegative(), type: z.string().max(200) });

// ---------------------------------------------------------------------------
// 1) Dosya yükleme — tarayıcı dosyayı doğrudan Supabase Storage'a yükler
//    (Vercel'in 4,5 MB istek sınırına takılmamak için). Sunucu önce imzalı yükleme
//    izni verir, yükleme bitince dosyayı depodan okuyup aktarımı oluşturur.
// ---------------------------------------------------------------------------
export async function prepareUploads(input: { kind: string; files: Array<{ name: string; size: number; type: string }> }): Promise<UploadPlanResult> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const kind = String(input.kind ?? "");
  const ext = UPLOAD_EXT[kind];
  if (!ext) return { error: "Dosya türünü seçin." };
  const files = z.array(fileMetaSchema).safeParse(input.files);
  if (!files.success || files.data.length === 0) return { error: "Bir dosya seçin." };
  if (kind !== "purchase_invoice_xml" && files.data.length > 1) return { error: "Bu türde tek seferde bir dosya yüklenir." };
  if (files.data.length > 20) return { error: "Tek seferde en fazla 20 fatura yükleyebilirsiniz." };
  for (const f of files.data) {
    if (!ext.test(f.name)) return { error: kind === "purchase_invoice_xml" ? `${f.name}: sadece .xml uzantılı e-Fatura dosyaları yüklenebilir.` : `${f.name}: desteklenen türler .xls, .xlsx, .csv.` };
    if (f.size === 0) return { error: `${f.name}: dosya boş.` };
    if (f.size > MAX_FILE_BYTES) return { error: `${f.name}: dosya 10 MB'tan büyük. Raporu daha kısa bir tarih aralığıyla dışa aktarın.` };
  }
  const uploads: Array<{ path: string; token: string }> = [];
  for (const f of files.data) {
    const path = `${org.id}/gelen/${randomUUID()}/${safeFileName(f.name)}`;
    const { data, error } = await supabase.storage.from("imports").createSignedUploadUrl(path);
    if (error || !data) return { error: "Yükleme hazırlanamadı. Sayfayı yenileyip tekrar deneyin." };
    uploads.push({ path, token: data.token });
  }
  return { ok: true, uploads };
}

/** Yedek yol: tarayıcıdan depoya doğrudan yükleme olmazsa küçük dosyalar (≤ 4 MB) sunucu üzerinden aynı yola yazılır. */
export async function uploadViaServer(form: FormData): Promise<{ ok?: boolean; error?: string }> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const path = String(form.get("path") ?? "");
  const file = form.get("file");
  if (!path.startsWith(`${org.id}/gelen/`) || path.includes("..")) return { error: "Geçersiz dosya yolu." };
  if (!(file instanceof File) || file.size === 0) return { error: "Dosya boş." };
  if (file.size > FALLBACK_MAX_BYTES) return { error: "Dosya yüklenemedi. İnternet bağlantınızı kontrol edip tekrar deneyin." };
  const { error } = await supabase.storage.from("imports").upload(path, new Uint8Array(await file.arrayBuffer()), {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) return { error: "Dosya kaydedilemedi. Biraz sonra tekrar deneyin." };
  return { ok: true };
}

async function readUploaded(supabase: Supa, orgId: string, path: string): Promise<Uint8Array> {
  if (!path.startsWith(`${orgId}/gelen/`) || path.includes("..")) throw new Error("Geçersiz dosya yolu.");
  const { data, error } = await supabase.storage.from("imports").download(path);
  if (error || !data) throw new Error("Yüklenen dosya okunamadı. Tekrar yükleyin.");
  const buf = new Uint8Array(await data.arrayBuffer());
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error("Dosya 10 MB'tan büyük.");
  return buf;
}

async function discard(supabase: Supa, path: string) {
  await supabase.storage.from("imports").remove([path]);
}

export async function registerUploads(input: { kind: string; files: Array<{ path: string; name: string; size: number; type: string }> }): Promise<UploadRegisterResult> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const kind = String(input.kind ?? "");
  const files = (input.files ?? []).slice(0, 20);
  if (!UPLOAD_EXT[kind] || files.length === 0) return { error: "Yükleme bilgisi eksik. Tekrar deneyin." };

  if (kind === "purchase_invoice_xml") {
    const results: string[] = [];
    const errors: string[] = [];
    let lastInvoice: string | null = null;
    for (const f of files) {
      try {
        const buf = await readUploaded(supabase, org.id, f.path);
        const hash = sha256(buf);
        const dup = await existingJobWithHash(supabase, org.id, kind, hash);
        if (dup) throw new UblError(`Bu dosya ${dup.status === "committed" ? "zaten işlenmiş" : "zaten yüklenmiş ve eşleştirme bekliyor"}.`);
        const inv = parseUblInvoice(decodeText(buf).text);
        const { data: job, error } = await supabase
          .from("import_jobs")
          .insert({ organization_id: org.id, kind, file_name: f.name, file_hash: hash, file_size: buf.byteLength, storage_path: f.path,
                    row_count: inv.lines.length, ok_count: inv.lines.length, params: { warnings: inv.warnings } })
          .select("id")
          .single();
        if (error) throw error;
        const { data: rows, error: rowErr } = await supabase
          .from("import_rows")
          .insert(inv.lines.map((l) => ({ organization_id: org.id, job_id: job.id, row_number: l.line_no, raw: l, parsed: l, status: "ok" })))
          .select("id, row_number");
        if (rowErr) throw rowErr;
        const rowIds = new Map((rows ?? []).map((r) => [r.row_number, r.id]));
        const { data: invId, error: stageErr } = await supabase.rpc("stage_purchase_invoice", {
          p_job: job.id,
          p_header: inv.header,
          p_lines: inv.lines.map((l) => ({ ...l, import_row_id: rowIds.get(l.line_no) })),
        });
        if (stageErr) {
          await supabase.rpc("cancel_import", { p_job: job.id });
          throw stageErr;
        }
        lastInvoice = String(invId);
        results.push(`${inv.header.invoice_no} (${inv.lines.length} satır)`);
      } catch (e) {
        await discard(supabase, f.path);
        errors.push(`${f.name}: ${e instanceof UblError ? e.message : e instanceof Error && !("code" in e) ? e.message : friendlyError(e)}`);
      }
    }
    revalidatePath("/faturalar");
    revalidatePath("/veri");
    if (results.length === 1 && errors.length === 0 && lastInvoice) return { ok: true, redirect: `/faturalar/${lastInvoice}` };
    if (results.length > 1 && errors.length === 0) return { ok: true, redirect: "/faturalar?durum=draft" };
    if (results.length === 0) return { error: errors.join(" · ") };
    return { ok: true, message: `${results.length} fatura eşleştirmeye hazır: ${results.join(", ")}.`, error: errors.length ? errors.join(" · ") : undefined };
  }

  if (!(TABLE_KINDS as readonly string[]).includes(kind)) return { error: "Dosya türünü seçin." };
  const f = files[0]!;
  let buf: Uint8Array;
  try {
    buf = await readUploaded(supabase, org.id, f.path);
  } catch (e) {
    return { error: (e as Error).message };
  }
  let table;
  try {
    table = readTable(buf, f.name);
  } catch (e) {
    await discard(supabase, f.path);
    return { error: e instanceof Error ? e.message : "Dosya okunamadı." };
  }
  const sheet = table.sheets[0];
  if (!sheet || sheet.rows.length < 2) {
    await discard(supabase, f.path);
    return { error: "Dosyada veri satırı bulunamadı." };
  }
  const hash = sha256(buf);
  const dup = await existingJobWithHash(supabase, org.id, kind, hash);
  if (dup) {
    await discard(supabase, f.path);
    return {
      error: dup.status === "committed"
        ? "Bu dosya daha önce işlenmiş. Aynı dosya iki kez işlenemez. Yanlışsa önce eski aktarımı geri alın."
        : "Bu dosya zaten yüklenmiş ve işlenmeyi bekliyor.",
      dupJobId: dup.id,
    };
  }
  const headerRow = detectHeaderRow(sheet.rows);
  const headers = headersAt(sheet.rows, headerRow);
  const signature = headerSignature(headers);
  const { data: profile } = await supabase
    .from("import_profiles").select("id, header_row, sheet_name").eq("organization_id", org.id).eq("kind", kind).eq("header_signature", signature).maybeSingle();

  const { data: job, error } = await supabase
    .from("import_jobs")
    .insert({
      organization_id: org.id, kind, file_name: f.name, file_hash: hash, file_size: buf.byteLength, storage_path: f.path, profile_id: profile?.id ?? null,
      params: { sheet: sheet.name, header_row: profile?.header_row ?? headerRow, encoding: table.encoding, format: table.format },
    })
    .select("id")
    .single();
  if (error) {
    await discard(supabase, f.path);
    return { error: friendlyError(error) };
  }
  revalidatePath("/veri");
  return { ok: true, redirect: `/veri/${job.id}` };
}

// ---------------------------------------------------------------------------
// 2) Eşleştirme ve satır hazırlama
// ---------------------------------------------------------------------------
const optionsSchema = z.object({
  decimalSeparator: z.enum([",", "."]),
  dateFormat: z.enum(["DD.MM.YYYY", "YYYY-MM-DD", "MM/DD/YYYY"]),
  vatIncluded: z.record(z.string(), z.boolean()),
  weighedQtyInGrams: z.boolean().optional(),
});

export async function stageJob(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const jobId = String(form.get("job_id") ?? "");
  let loaded;
  try {
    loaded = await loadJobTable(jobId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : friendlyError(e) };
  }
  const { job, sheet } = loaded;
  if (job.status !== "staged") return { error: "Bu aktarım işlenmiş veya iptal edilmiş; değiştirilemez." };
  const kind = job.kind as TableKind;

  const headerRow = Math.max(0, Math.min(sheet.rows.length - 1, Number(form.get("header_row") ?? job.params.header_row ?? 0)));
  const headers = headersAt(sheet.rows, headerRow);
  const mapping: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const v = String(form.get(`map_${f.key}`) ?? "");
    if (v && headers.includes(v)) mapping[f.key] = v;
  }
  const missing = missingRequired(kind, mapping);
  if (missing.length) return { error: `Eşleştirilmesi gereken alanlar: ${missing.map((m) => m.label).join(", ")}.` };

  const vatIncluded: Record<string, boolean> = {};
  const priceFieldsMapped = FIELDS[kind].filter((f) => f.price && mapping[f.key]);
  for (const f of priceFieldsMapped) {
    const v = form.get(`vat_${f.key}`);
    if (v !== "1" && v !== "0") return { error: `"${f.label}" sütunundaki fiyatların KDV dahil olup olmadığını seçin.` };
    vatIncluded[f.key] = v === "1";
  }
  const parsedOpts = optionsSchema.safeParse({
    decimalSeparator: form.get("decimal_separator"),
    dateFormat: form.get("date_format") ?? "DD.MM.YYYY",
    vatIncluded,
    weighedQtyInGrams: form.get("grams") === "1",
  });
  if (!parsedOpts.success) return { error: "Sayı biçimini (ondalık ayracı) seçin." };
  const opts: ProfileOptions = parsedOpts.data;

  const params: Record<string, string> = {};
  for (const k of ["period_start", "period_end", "stock_date", "invoice_no", "invoice_date", "supplier_id"]) {
    const v = String(form.get(k) ?? "").trim();
    if (v) params[k] = v;
  }
  if (kind === "sales_summary") {
    if (!params.period_start || !params.period_end || !isIsoDate(params.period_start) || !isIsoDate(params.period_end))
      return { error: "Raporun başlangıç ve bitiş tarihini seçin." };
    if (params.period_end < params.period_start) return { error: "Bitiş tarihi başlangıçtan önce olamaz." };
  }
  if (kind === "product_list" && (!params.stock_date || !isIsoDate(params.stock_date))) return { error: "Listenin hangi günün stoğunu gösterdiğini seçin." };
  if (kind === "purchase_invoice_table" && !params.supplier_id) return { error: "Tedarikçiyi seçin." };

  // Bağlam: ürünler, KDV oranları, (ürün listesi için) hesaplanan stok
  const [products, vatRate] = await Promise.all([loadProducts(supabase, org.id), loadVatLookup(supabase, org.id)]);
  let stockAt: Map<string, { stock: string | null; hasOpening: boolean }> | undefined;
  if (kind === "product_list") {
    const levels = await fetchAll<{ product_id: string; stock: string | null; has_opening: boolean }>((from, to) =>
      supabase.rpc("stock_levels_at", { p_org: org.id, p_date: params.stock_date! }).range(from, to),
    );
    stockAt = new Map(levels.map((l) => [l.product_id, { stock: l.stock, hasOpening: l.has_opening }]));
  }

  // Önceki hazırlık varsa silinir (iş hâlâ "staged")
  await supabase.from("import_rows").delete().eq("job_id", job.id);

  let staged: StagedRow[];
  let invoices: ReturnType<typeof transformInvoiceTable>["invoices"] = [];
  if (kind === "purchase_invoice_table") {
    const { count } = await supabase.from("purchase_invoices").select("id", { count: "exact", head: true }).eq("import_job_id", job.id).neq("status", "cancelled");
    if ((count ?? 0) > 0) return { error: "Bu dosyadan fatura taslağı oluşturuldu. Değiştirmek için aktarımı iptal edip dosyayı yeniden yükleyin." };
    const r = transformInvoiceTable(sheet.rows, headerRow, headers, mapping, opts, params);
    staged = r.staged;
    invoices = r.invoices;
  } else {
    staged = transformRows(kind, sheet.rows, headerRow, headers, mapping, opts, params, { products, vatRate, stockAt }).rows;
  }
  if (staged.length === 0) return { error: "Başlık satırından sonra veri bulunamadı. Başlık satırını kontrol edin." };

  const rowIds = new Map<number, string>();
  for (let i = 0; i < staged.length; i += 500) {
    const chunk = staged.slice(i, i + 500).map((r) => ({
      organization_id: org.id, job_id: job.id, row_number: r.row_number, raw: r.raw, parsed: r.parsed, status: r.status, messages: r.messages, product_id: r.product_id,
    }));
    const { data, error } = await supabase.from("import_rows").insert(chunk).select("id, row_number");
    if (error) return { error: friendlyError(error) };
    (data ?? []).forEach((d) => rowIds.set(d.row_number, d.id));
  }

  const c = { ok: 0, warning: 0, error: 0 };
  staged.forEach((r) => {
    if (r.status === "ok") c.ok++;
    else if (r.status === "warning") c.warning++;
    else if (r.status === "error" || r.status === "needs_review" || r.status === "duplicate") c.error++;
  });
  const signature = headerSignature(headers);
  const profileName = String(form.get("profile_name") ?? "").trim();
  let profileId = job.profile_id;
  if (form.get("save_profile") === "1") {
    const payload = {
      organization_id: org.id, name: profileName || `${job.file_name} profili`, source_system: String(form.get("source_system") ?? "").trim() || null,
      kind, header_signature: signature, headers, header_row: headerRow, sheet_name: sheet.name, column_map: mapping, options: opts,
    };
    const existing = await supabase.from("import_profiles").select("id").eq("organization_id", org.id).eq("kind", kind).eq("header_signature", signature).maybeSingle();
    if (existing.data) {
      await supabase.from("import_profiles").update({ name: payload.name, source_system: payload.source_system, header_row: headerRow, sheet_name: sheet.name, column_map: mapping, options: opts, updated_at: new Date().toISOString() }).eq("id", existing.data.id);
      profileId = existing.data.id;
    } else {
      const ins = await supabase.from("import_profiles").insert(payload).select("id").single();
      if (ins.error) return { error: friendlyError(ins.error) };
      profileId = ins.data.id;
    }
  }
  const { error: upErr } = await supabase
    .from("import_jobs")
    .update({ params: { ...withoutPreview(job.params), ...params, header_row: headerRow, mapping, options: opts }, row_count: staged.length, ok_count: c.ok, warning_count: c.warning, error_count: c.error, profile_id: profileId })
    .eq("id", job.id);
  if (upErr) return { error: friendlyError(upErr) };

  if (kind === "purchase_invoice_table") {
    if (invoices.length === 0) return { error: "Faturaya dönüştürülebilecek satır yok. Hatalı satırları kontrol edin." };
    let first: string | null = null;
    for (const inv of invoices) {
      const { data, error } = await supabase.rpc("stage_purchase_invoice", {
        p_job: job.id,
        p_header: {
          invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, supplier_id: params.supplier_id,
          calc_total_excl_vat: inv.totals.exclVat, calc_total_vat: inv.totals.vat, calc_total_incl_vat: inv.totals.inclVat, total_mismatch: false,
        },
        p_lines: inv.lines.map((l) => ({ ...l, import_row_id: l.row_number ? rowIds.get(l.row_number) : undefined })),
      });
      if (error) return { error: friendlyError(error) };
      first ??= String(data);
    }
    revalidatePath("/faturalar");
    redirect(invoices.length === 1 && first ? `/faturalar/${first}` : "/faturalar?durum=draft");
  }

  revalidatePath(`/veri/${job.id}`);
  return { ok: true, message: "Satırlar hazırlandı. Aşağıdaki önizlemeyi kontrol edip kaydedin." };
}

// ---------------------------------------------------------------------------
// 3) Önizleme aşaması işlemleri
// ---------------------------------------------------------------------------
export async function setCountApprovals(form: FormData): Promise<void> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  const approved = new Set(form.getAll("approve").map(String));
  const rows = await fetchAll<{ id: string; parsed: Record<string, unknown> }>((from, to) =>
    supabase.from("import_rows").select("id, parsed").eq("job_id", jobId).not("parsed->count_diff", "is", null).order("row_number").range(from, to),
  );
  for (const r of rows) {
    const want = approved.has(r.id);
    if (Boolean(r.parsed.apply_count) !== want) {
      await supabase.from("import_rows").update({ parsed: { ...r.parsed, apply_count: want } }).eq("id", r.id);
    }
  }
  await clearCommitPreview(supabase, jobId);
  revalidatePath(`/veri/${jobId}`);
}

/** Eşleşmeyen satış satırlarındaki ürünleri yeni ürün olarak açar ve satırları yeniden hazırlar. */
export async function createMissingProducts(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  const vat = String(form.get("vat_rate") ?? "").replace(",", ".");
  const baseUnit = String(form.get("base_unit") ?? "adet");
  if (!/^\d{1,2}(\.\d+)?$/.test(vat)) return { error: "Yeni ürünler için KDV oranını seçin." };
  if (!["adet", "kg", "lt"].includes(baseUnit)) return { error: "Birim seçin." };
  const rows = await fetchAll<{ id: string; parsed: Record<string, unknown> | null; raw: Record<string, unknown> }>((from, to) =>
    supabase.from("import_rows").select("id, parsed, raw").eq("job_id", jobId).eq("status", "needs_review").order("row_number").range(from, to),
  );
  const job = await loadJob(supabase, jobId);
  const mapping = (job.params.mapping ?? {}) as Record<string, string>;
  const seen = new Set<string>();
  const created: string[] = [];
  for (const r of rows) {
    const name = String(r.parsed?.name ?? (mapping.name ? r.raw[mapping.name] : "") ?? "").trim();
    const barcode = (r.parsed?.barcode as string | null) ?? null;
    const code = (r.parsed?.code as string | null) ?? null;
    const key = barcode ?? code ?? name.toLocaleLowerCase("tr-TR");
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const { data, error } = await supabase.from("products").insert({ organization_id: org.id, name, barcode, code, base_unit: baseUnit, is_weighed: baseUnit === "kg" }).select("id").single();
    if (error) return { error: `${name}: ${friendlyError(error)}` };
    created.push(data.id);
  }
  if (created.length) {
    const { error } = await supabase.rpc("set_vat_rate", { p_org: org.id, p_products: created, p_rate: vat, p_valid_from: "2000-01-01" });
    if (error) return { error: friendlyError(error) };
  }
  return restage(jobId, `${created.length} yeni ürün eklendi.`);
}

export async function skipUnmatched(form: FormData): Promise<void> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  await supabase.from("import_rows").update({ status: "skipped", messages: ["Kullanıcı atladı: ürün eşleşmedi"] }).eq("job_id", jobId).eq("status", "needs_review");
  await clearCommitPreview(supabase, jobId);
  revalidatePath(`/veri/${jobId}`);
}

/** Kayıtlı eşleştirme ile satırları yeniden hazırlar. */
async function restage(jobId: string, message: string): Promise<ActionState> {
  const supabase = await createClient();
  const job = await loadJob(supabase, jobId);
  const p = job.params as Record<string, unknown>;
  const form = new FormData();
  form.set("job_id", jobId);
  form.set("header_row", String(p.header_row ?? 0));
  for (const [k, v] of Object.entries((p.mapping ?? {}) as Record<string, string>)) form.set(`map_${k}`, v);
  const o = (p.options ?? {}) as ProfileOptions;
  form.set("decimal_separator", o.decimalSeparator ?? ",");
  form.set("date_format", o.dateFormat ?? "DD.MM.YYYY");
  for (const [k, v] of Object.entries(o.vatIncluded ?? {})) form.set(`vat_${k}`, v ? "1" : "0");
  if (o.weighedQtyInGrams) form.set("grams", "1");
  for (const k of ["period_start", "period_end", "stock_date", "invoice_no", "invoice_date", "supplier_id"]) if (p[k]) form.set(k, String(p[k]));
  const res = await stageJob(undefined, form);
  return res.error ? res : { ok: true, message };
}

// ---------------------------------------------------------------------------
// 4) Kesinleştirme, iptal, geri alma
// ---------------------------------------------------------------------------
export async function commitJob(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  const version = String(form.get("ledger_version") ?? "");
  const { error } = await supabase.rpc("commit_import", { p_job: jobId, p_expected_version: version ? Number(version) : null });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  redirect(`/veri/${jobId}?kaydedildi=1`);
}

export async function cancelJob(form: FormData): Promise<void> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  await supabase.rpc("cancel_import", { p_job: jobId });
  revalidatePath("/veri");
  redirect("/veri");
}

export async function revertJob(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 3) return { fieldErrors: { reason: "Geri alma nedenini yazın." } };
  const version = String(form.get("ledger_version") ?? "");
  const { error } = await supabase.rpc("revert_import", { p_job: jobId, p_reason: reason, p_expected_version: version ? Number(version) : null });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  redirect(`/veri/${jobId}?geri_alindi=1`);
}

export async function deleteProfile(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.from("import_profiles").delete().eq("id", String(form.get("profile_id")));
  revalidatePath("/veri");
}

