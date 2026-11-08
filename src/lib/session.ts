import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const ORG_COOKIE = "kd_org";

export interface OrgInfo {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  closed_through: string | null;
  margin_alert_threshold_pts: string;
  dead_stock_days: number;
  price_rounding_step: string;
  ledger_version: string;
}

export const getUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
});

export const getMemberships = cache(async (): Promise<OrgInfo[]> => {
  const supabase = await createClient();
  const user = await getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("organization_members")
    .select("role, organizations(id, name, closed_through, margin_alert_threshold_pts::text, dead_stock_days, price_rounding_step::text, ledger_version::text)")
    .eq("user_id", user.id)
    .order("created_at");
  if (error) throw new Error("İşletme bilgileri alınamadı. Sayfayı yenileyin.");
  return (data ?? []).flatMap((m) => {
    const o = m.organizations as unknown as Omit<OrgInfo, "role"> | null;
    return o ? [{ ...o, role: m.role as OrgInfo["role"] }] : [];
  });
});

/** Oturum + işletme zorunlu sayfalar için. İşletme yoksa oluşturma ekranına gönderir. */
export const requireOrg = cache(async (): Promise<{ org: OrgInfo; orgs: OrgInfo[]; userEmail: string }> => {
  const user = await getUser();
  if (!user) redirect("/giris");
  const orgs = await getMemberships();
  if (orgs.length === 0) redirect("/isletme-olustur");
  const chosen = (await cookies()).get(ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.id === chosen) ?? orgs[0]!;
  return { org, orgs, userEmail: user.email ?? "" };
});
