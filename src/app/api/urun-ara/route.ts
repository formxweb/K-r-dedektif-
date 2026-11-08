import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";

/** Eşleştirme için ürün arama (ad, barkod, stok kodu). RLS altında çalışır. */
export async function GET(request: NextRequest) {
  const { org } = await requireOrg();
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 60);
  if (q.length < 2) return NextResponse.json([]);
  const supabase = await createClient();
  const safe = q.replace(/[%_,()"\\]/g, " ").trim();
  const { data, error } = await supabase
    .from("products")
    .select("id, name, barcode, code, base_unit")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .or(`name.ilike."%${safe}%",barcode.eq."${safe}",code.eq."${safe}"`)
    .order("name")
    .limit(15);
  if (error) return NextResponse.json({ error: "Arama yapılamadı" }, { status: 500 });
  return NextResponse.json(data ?? []);
}
