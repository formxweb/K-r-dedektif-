"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";
import { friendlyError, type ActionState } from "@/lib/errors";

function amount(v: FormDataEntryValue | null, label: string, required = true): string | null {
  const s = String(v ?? "").trim().replace(/\s|₺/g, "");
  if (!s) {
    if (required) throw new Error(`${label} girin.`);
    return null;
  }
  const norm = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d{1,4})?$/.test(norm)) throw new Error(`${label} geçerli bir tutar olmalı (örn. 12.500,00).`);
  return norm;
}

function month(v: FormDataEntryValue | null): string {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}$/.test(s)) throw new Error("Ay seçin.");
  return `${s}-01`;
}

function done(m: string, message?: string): ActionState {
  revalidatePath("/giderler");
  revalidatePath("/genel-bakis");
  return { ok: true, message: message ?? "Kaydedildi.", data: { m } };
}

export async function addExpense(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  try {
    const m = month(form.get("month"));
    const a = amount(form.get("amount"), "Tutar")!;
    if (Number(a) <= 0) return { fieldErrors: { amount: "Tutar sıfırdan büyük olmalı." } };
    const { error } = await supabase.from("expenses").insert({
      organization_id: org.id, category_id: String(form.get("category_id")), month: m, amount: a,
      vat_amount: amount(form.get("vat_amount"), "KDV", false) ?? "0", description: String(form.get("description") ?? "").trim() || null,
    });
    if (error) return { error: friendlyError(error) };
    return done(m, "Gider eklendi.");
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function back(form: FormData, error?: { message?: string; code?: string } | null): never {
  const ym = String(form.get("ym") ?? "");
  const q = new URLSearchParams();
  if (/^\d{4}-\d{2}$/.test(ym)) q.set("ay", ym);
  if (error) q.set("hata", friendlyError(error));
  revalidatePath("/giderler");
  revalidatePath("/genel-bakis");
  redirect(`/giderler${q.size ? `?${q}` : ""}`);
}

export async function deleteExpense(form: FormData): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("expenses").delete().eq("id", String(form.get("id")));
  back(form, error);
}

export async function setExpenseStatus(form: FormData): Promise<void> {
  const supabase = await createClient();
  const status = String(form.get("status"));
  if (status !== "approved" && status !== "skipped") return;
  const patch: Record<string, string | null> = { status, approved_at: status === "approved" ? new Date().toISOString() : null };
  const newAmount = String(form.get("amount") ?? "").trim();
  if (newAmount) {
    try {
      patch.amount = amount(newAmount, "Tutar");
    } catch {
      return;
    }
  }
  const { error } = await supabase.from("expenses").update(patch).eq("id", String(form.get("id")));
  back(form, error);
}

export async function addRecurring(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  try {
    const m = month(form.get("start_month"));
    const description = String(form.get("description") ?? "").trim();
    if (!description) return { fieldErrors: { description: "Açıklama yazın (örn. Dükkan kirası)." } };
    const { error } = await supabase.from("recurring_expenses").insert({
      organization_id: org.id, category_id: String(form.get("category_id")), description,
      amount: amount(form.get("amount"), "Tutar"), vat_amount: amount(form.get("vat_amount"), "KDV", false) ?? "0", start_month: m,
    });
    if (error) return { error: friendlyError(error) };
    await supabase.rpc("generate_recurring_expenses", { p_org: org.id, p_month: m });
    return done(m, "Tekrarlayan gider eklendi. Her ay onayınıza sunulur.");
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function stopRecurring(form: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.from("recurring_expenses").update({ is_active: false }).eq("id", String(form.get("id")));
  revalidatePath("/giderler");
}

export async function addRebate(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  try {
    const m = month(form.get("month"));
    const { error } = await supabase.from("supplier_rebates").insert({
      organization_id: org.id, supplier_id: String(form.get("supplier_id")), month: m,
      amount: amount(form.get("amount"), "Tutar"), description: String(form.get("description") ?? "").trim() || null,
    });
    if (error) return { error: friendlyError(error) };
    return done(m, "Tedarikçi primi eklendi.");
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function deleteRebate(form: FormData): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("supplier_rebates").delete().eq("id", String(form.get("id")));
  back(form, error);
}
