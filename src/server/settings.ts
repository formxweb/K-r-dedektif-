"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";
import { friendlyError, type ActionState } from "@/lib/errors";
import { fetchAll } from "@/lib/data/common";

function dot(v: FormDataEntryValue | null): string {
  const s = String(v ?? "").trim().replace(/\s/g, "");
  return s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
}

export async function saveOrgSettings(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const parsed = z.object({
    name: z.string().trim().min(2, "İşletme adı en az 2 karakter olmalı."),
    threshold: z.string().regex(/^\d+(\.\d+)?$/, "Marj eşiği bir sayı olmalı."),
    dead: z.coerce.number().int().min(7, "Ölü stok süresi en az 7 gün.").max(730),
    step: z.string().regex(/^\d+(\.\d+)?$/, "Yuvarlama adımı bir sayı olmalı.").refine((v) => Number(v) > 0, "Yuvarlama adımı sıfırdan büyük olmalı."),
  }).safeParse({ name: form.get("name"), threshold: dot(form.get("threshold")), dead: form.get("dead"), step: dot(form.get("step")) });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  const { error } = await supabase.rpc("update_organization_settings", {
    p_org: org.id, p_name: parsed.data.name, p_margin_threshold: parsed.data.threshold, p_dead_stock_days: parsed.data.dead, p_rounding_step: parsed.data.step,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  return { ok: true, message: "Ayarlar kaydedildi." };
}

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Tedarikçi adını yazın.").max(200),
  tax_number: z.string().trim().regex(/^(\d{10,11})?$/, "VKN 10, TCKN 11 haneli olmalı.").optional(),
  lead_time_days: z.coerce.number().int().min(0, "Teslim süresi 0 veya daha büyük olmalı.").max(90),
  order_interval_days: z.coerce.number().int().min(1, "Sipariş aralığı en az 1 gün.").max(90),
  min_order_amount: z.string().regex(/^(\d+(\.\d+)?)?$/, "Minimum sipariş tutarı sayı olmalı.").optional(),
  phone: z.string().trim().max(40).optional(),
});

export async function saveSupplier(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const parsed = supplierSchema.safeParse({
    name: form.get("name"), tax_number: form.get("tax_number") ?? "", lead_time_days: form.get("lead_time_days"),
    order_interval_days: form.get("order_interval_days"), min_order_amount: dot(form.get("min_order_amount")), phone: form.get("phone") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  const payload = {
    name: parsed.data.name, tax_number: parsed.data.tax_number || null, lead_time_days: parsed.data.lead_time_days,
    order_interval_days: parsed.data.order_interval_days, min_order_amount: parsed.data.min_order_amount || null, phone: parsed.data.phone || null,
  };
  const id = String(form.get("id") ?? "");
  const res = id
    ? await supabase.from("suppliers").update(payload).eq("id", id)
    : await supabase.from("suppliers").insert({ organization_id: org.id, ...payload });
  if (res.error) return { error: friendlyError(res.error) };
  revalidatePath("/ayarlar");
  return { ok: true, message: id ? "Tedarikçi güncellendi." : "Tedarikçi eklendi." };
}

export async function bulkVatChange(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const fromRate = dot(form.get("from_rate"));
  const toRate = dot(form.get("to_rate"));
  const validFrom = String(form.get("valid_from") ?? "");
  if (!/^\d+(\.\d+)?$/.test(fromRate) || !/^\d+(\.\d+)?$/.test(toRate)) return { error: "Oranları seçin." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return { error: "Geçerlilik tarihini seçin." };
  const rows = await fetchAll<{ product_id: string }>((a, b) =>
    supabase.from("tax_rates").select("product_id").eq("organization_id", org.id).eq("rate", fromRate).is("valid_to", null).order("id").range(a, b));
  if (rows.length === 0) return { error: `Şu an %${fromRate} KDV'li ürün yok.` };
  const ids = rows.map((r) => r.product_id);
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase.rpc("set_vat_rate", { p_org: org.id, p_products: ids.slice(i, i + 500), p_rate: toRate, p_valid_from: validFrom });
    if (error) return { error: friendlyError(error) };
  }
  revalidatePath("/ayarlar");
  return { ok: true, message: `${ids.length} ürünün KDV oranı ${validFrom} itibarıyla %${toRate} oldu.` };
}

export async function addMarker(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const parsed = z.object({
    name: z.string().trim().min(1, "Dönem adını yazın (örn. Ramazan)."),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Başlangıç tarihini seçin."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Bitiş tarihini seçin."),
    multiplier: z.string().regex(/^\d+(\.\d+)?$/, "Çarpan sayı olmalı (örn. 1,3).").refine((v) => Number(v) > 0 && Number(v) <= 10, "Çarpan 0 ile 10 arasında olmalı."),
  }).safeParse({ name: form.get("name"), start_date: form.get("start_date"), end_date: form.get("end_date"), multiplier: dot(form.get("multiplier")) });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  if (parsed.data.end_date < parsed.data.start_date) return { error: "Bitiş tarihi başlangıçtan önce olamaz." };
  const { error } = await supabase.from("period_markers").insert({ organization_id: org.id, ...parsed.data, category_id: String(form.get("category_id") ?? "") || null });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/ayarlar");
  return { ok: true, message: "Dönem işareti eklendi. Bir sonraki öneri hesaplamasında kullanılır." };
}

export async function deleteMarker(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.from("period_markers").delete().eq("id", String(form.get("id")));
  revalidatePath("/ayarlar");
}

export async function closePeriod(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { error } = await supabase.rpc("close_period", { p_org: org.id, p_month: String(form.get("month")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  return { ok: true, message: "Dönem kapatıldı. Bu ayın kâr tablosu artık değişmez; geç gelen maliyet farkları açık aya yazılır." };
}

export async function reopenPeriod(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reopen_period", { p_org: org.id, p_month: String(form.get("month")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  const r = data as { revisions: number; adjustments: number };
  return { ok: true, message: `Dönem yeniden açıldı. ${r.revisions} kaydın maliyeti güncel hesaba çekildi.` };
}
