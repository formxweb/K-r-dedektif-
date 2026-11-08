"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError, type ActionState } from "@/lib/errors";

function factorOf(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(s) || Number(s) <= 0) throw new Error("Katsayı sıfırdan büyük bir sayı olmalı (örn. 24 veya 0,5).");
  return s;
}

export async function matchItem(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const itemId = String(form.get("item_id"));
  const productId = String(form.get("product_id") ?? "");
  const invoiceId = String(form.get("invoice_id"));
  if (!/^[0-9a-f-]{36}$/.test(productId)) return { error: "Listeden bir ürün seçin." };
  let factor: string | null;
  try {
    factor = factorOf(form.get("factor"));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { error } = await supabase.rpc("match_purchase_item", {
    p_item: itemId, p_product: productId, p_unit_factor: factor, p_unit_name: String(form.get("unit_name") ?? "") || null, p_save_alias: true,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/faturalar/${invoiceId}`);
  return { ok: true };
}

export async function ignoreItem(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("ignore_purchase_item", { p_item: String(form.get("item_id")), p_ignored: form.get("ignored") === "1" });
  revalidatePath(`/faturalar/${String(form.get("invoice_id"))}`);
}

export async function createProductForItem(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Ürün adını yazın." };
  let factor: string | null;
  try {
    factor = factorOf(form.get("factor"));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { error } = await supabase.rpc("create_product_for_item", {
    p_item: String(form.get("item_id")), p_name: name, p_base_unit: String(form.get("base_unit") ?? "adet"),
    p_barcode: String(form.get("barcode") ?? "").trim() || null, p_unit_factor: factor, p_unit_name: String(form.get("unit_name") ?? "") || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/faturalar/${String(form.get("invoice_id"))}`);
  return { ok: true };
}

export async function postInvoice(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const jobId = String(form.get("job_id"));
  const version = String(form.get("ledger_version") ?? "");
  const { error } = await supabase.rpc("commit_import", { p_job: jobId, p_expected_version: version ? Number(version) : null });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/", "layout");
  redirect(`/faturalar/${String(form.get("invoice_id"))}?islendi=1`);
}

export async function cancelInvoiceJob(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("cancel_import", { p_job: String(form.get("job_id")) });
  revalidatePath("/faturalar");
  redirect("/faturalar");
}
