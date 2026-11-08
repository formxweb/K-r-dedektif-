"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";
import { friendlyError, type ActionState } from "@/lib/errors";

function decText(v: FormDataEntryValue | null, opts: { allowZero?: boolean } = {}): string | null {
  const s = String(v ?? "").trim().replace(/\s/g, "");
  if (!s) return null;
  const norm = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d+)?$/.test(norm)) throw new Error("Geçerli bir sayı girin (örn. 12,5).");
  if (!opts.allowZero && Number(norm) === 0) throw new Error("Değer sıfırdan büyük olmalı.");
  return norm;
}

export async function updateProduct(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const id = String(form.get("product_id"));
  const parsed = z.object({
    name: z.string().trim().min(1, "Ürün adını yazın.").max(200),
    barcode: z.string().trim().max(64).optional(),
    code: z.string().trim().max(64).optional(),
    base_unit: z.enum(["adet", "kg", "lt"]),
    shelf_life_days: z.string().trim().regex(/^\d*$/, "Raf ömrü gün sayısı olmalı.").optional(),
    category: z.string().trim().max(80).optional(),
  }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  let categoryId: string | null = null;
  if (parsed.data.category) {
    const existing = await supabase.from("categories").select("id").eq("organization_id", org.id).ilike("name", parsed.data.category).maybeSingle();
    if (existing.data) categoryId = existing.data.id;
    else {
      const ins = await supabase.from("categories").insert({ organization_id: org.id, name: parsed.data.category }).select("id").single();
      if (ins.error) return { error: friendlyError(ins.error) };
      categoryId = ins.data.id;
    }
  }
  const { error } = await supabase.from("products").update({
    name: parsed.data.name,
    barcode: parsed.data.barcode || null,
    code: parsed.data.code || null,
    base_unit: parsed.data.base_unit,
    is_weighed: parsed.data.base_unit === "kg",
    shelf_life_days: parsed.data.shelf_life_days ? Number(parsed.data.shelf_life_days) : null,
    category_id: categoryId,
    is_active: form.get("is_active") === "1",
  }).eq("id", id);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/urunler/${id}`);
  return { ok: true, message: "Ürün bilgileri kaydedildi." };
}

export async function addUnit(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const id = String(form.get("product_id"));
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Birim adını yazın (örn. Koli)." };
  let factor: string | null;
  try {
    factor = decText(form.get("factor"));
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!factor) return { error: "Katsayıyı girin (örn. 24)." };
  const { error } = await supabase.from("product_units").insert({ organization_id: org.id, product_id: id, name, factor, barcode: String(form.get("barcode") ?? "").trim() || null });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/urunler/${id}`);
  return { ok: true, message: `${name} birimi eklendi.` };
}

export async function deleteUnit(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.from("product_units").delete().eq("id", String(form.get("unit_id")));
  revalidatePath(`/urunler/${String(form.get("product_id"))}`);
}

export async function addMovement(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const id = String(form.get("product_id"));
  const type = String(form.get("type"));
  let qty: string | null;
  try {
    qty = decText(form.get("qty"), { allowZero: type === "count_adjustment" });
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (qty === null) return { error: "Miktarı girin." };
  const { error } = await supabase.rpc("add_manual_movement", { p_product: id, p_type: type, p_qty: qty, p_date: String(form.get("date")), p_note: String(form.get("note") ?? "") });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/urunler/${id}`);
  revalidatePath("/genel-bakis");
  return { ok: true, message: "Hareket kaydedildi; stok ve maliyet yeniden hesaplandı." };
}

export async function voidMovement(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("void_manual_movement", { p_movement: String(form.get("movement_id")), p_reason: "Elle iptal" });
  revalidatePath(`/urunler/${String(form.get("product_id"))}`);
}

export async function setProductVat(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const id = String(form.get("product_id"));
  let rate: string | null;
  try {
    rate = decText(form.get("rate"), { allowZero: true });
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { error } = await supabase.rpc("set_vat_rate", { p_org: org.id, p_products: [id], p_rate: rate, p_valid_from: String(form.get("valid_from")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/urunler/${id}`);
  return { ok: true, message: "KDV oranı kaydedildi. Geçmiş aktarımların KDV ayrımı değişmez; yeni aktarımlarda kullanılır." };
}

export async function setProductSupplier(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const id = String(form.get("product_id"));
  const supplierId = String(form.get("supplier_id") ?? "");
  if (!supplierId) return { error: "Tedarikçi seçin." };
  let factor: string | null, minQty: string | null;
  try {
    factor = decText(form.get("order_unit_factor"));
    minQty = decText(form.get("min_order_qty"), { allowZero: true });
  } catch (e) {
    return { error: (e as Error).message };
  }
  await supabase.from("product_suppliers").update({ is_primary: false }).eq("product_id", id).neq("supplier_id", supplierId);
  const payload = { is_primary: true, order_unit_name: String(form.get("order_unit_name") ?? "").trim() || null, order_unit_factor: factor, min_order_qty: minQty };
  const existing = await supabase.from("product_suppliers").select("id").eq("product_id", id).eq("supplier_id", supplierId).maybeSingle();
  const res = existing.data
    ? await supabase.from("product_suppliers").update(payload).eq("id", existing.data.id)
    : await supabase.from("product_suppliers").insert({ organization_id: org.id, product_id: id, supplier_id: supplierId, ...payload });
  if (res.error) return { error: friendlyError(res.error) };
  revalidatePath(`/urunler/${id}`);
  return { ok: true, message: "Sipariş bilgileri kaydedildi." };
}
