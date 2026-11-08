import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** E-posta doğrulama ve şifre sıfırlama bağlantılarının dönüşü (PKCE kodu → oturum). */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nextRaw = url.searchParams.get("sonra") ?? "/genel-bakis";
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/genel-bakis";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL("/giris?hata=baglanti", url.origin));
}
