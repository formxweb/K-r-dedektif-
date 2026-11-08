"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { friendlyError, type ActionState } from "@/lib/errors";
import { ORG_COOKIE } from "@/lib/session";

const email = z.string().trim().toLowerCase().email("Geçerli bir e-posta adresi girin.");
const password = z.string().min(8, "Şifre en az 8 karakter olmalı.").max(72, "Şifre en fazla 72 karakter olabilir.");

function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/genel-bakis";
}

function authMessage(msg: string): string {
  if (/Invalid login credentials/i.test(msg)) return "E-posta veya şifre hatalı.";
  if (/Email not confirmed/i.test(msg)) return "E-posta adresiniz henüz doğrulanmadı. Gelen kutunuzdaki bağlantıya tıklayın.";
  if (/already registered|already exists/i.test(msg)) return "Bu e-posta ile kayıtlı bir hesap var. Giriş yapın veya şifrenizi sıfırlayın.";
  if (/rate limit|too many/i.test(msg)) return "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin.";
  if (/weak|pwned|password/i.test(msg)) return "Bu şifre güvenli değil. Daha uzun ve tahmin edilmesi zor bir şifre seçin.";
  return "İşlem tamamlanamadı. Bilgileri kontrol edip tekrar deneyin.";
}

export async function signIn(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const parsed = z.object({ email, password: z.string().min(1, "Şifrenizi girin.") }).safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: authMessage(error.message) };
  redirect(safeNext(form.get("sonra")));
}

export async function signUp(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ full_name: z.string().trim().min(2, "Adınızı yazın.").max(80), email, password })
    .safeParse({ full_name: form.get("full_name"), email: form.get("email"), password: form.get("password") });
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.full_name }, emailRedirectTo: `${env.siteUrl}/auth/callback?sonra=/isletme-olustur` },
  });
  if (error) return { error: authMessage(error.message) };
  if (data.session) redirect("/isletme-olustur");
  return { ok: true, message: `Doğrulama bağlantısı ${parsed.data.email} adresine gönderildi. Bağlantıya tıkladıktan sonra işletmenizi oluşturabilirsiniz.` };
}

export async function requestPasswordReset(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const parsed = email.safeParse(form.get("email"));
  if (!parsed.success) return { fieldErrors: { email: parsed.error.issues[0]!.message } };
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${env.siteUrl}/auth/callback?sonra=/sifre-yenile` });
  // Hesap var/yok bilgisi sızdırılmaz.
  return { ok: true, message: "Bu adresle kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi." };
}

export async function updatePassword(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const parsed = password.safeParse(form.get("password"));
  if (!parsed.success) return { fieldErrors: { password: parsed.error.issues[0]!.message } };
  if (form.get("password") !== form.get("password2")) return { fieldErrors: { password2: "Şifreler aynı değil." } };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { error: authMessage(error.message) };
  redirect("/genel-bakis");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ORG_COOKIE);
  redirect("/giris");
}

export async function createOrganization(_: ActionState | undefined, form: FormData): Promise<ActionState> {
  const name = z.string().trim().min(2, "İşletme adı en az 2 karakter olmalı.").max(120).safeParse(form.get("name"));
  if (!name.success) return { fieldErrors: { name: name.error.issues[0]!.message } };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization", { p_name: name.data });
  if (error) return { error: friendlyError(error) };
  (await cookies()).set(ORG_COOKIE, String(data), { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/veri");
}

export async function switchOrganization(form: FormData): Promise<void> {
  const id = String(form.get("org") ?? "");
  if (/^[0-9a-f-]{36}$/.test(id)) {
    (await cookies()).set(ORG_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  redirect("/genel-bakis");
}
