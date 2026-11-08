import type { ReactNode } from "react";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { signOut, switchOrganization } from "@/server/auth";
import { AppShell, type NavItem } from "@/components/shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { org, orgs, userEmail } = await requireOrg();
  const supabase = await createClient();
  const [{ count: alertCount }, { count: draftCount }] = await Promise.all([
    supabase.from("alerts").select("id", { count: "exact", head: true }).eq("organization_id", org.id).eq("status", "open"),
    supabase.from("purchase_invoices").select("id", { count: "exact", head: true }).eq("organization_id", org.id).eq("status", "draft"),
  ]);

  const nav: NavItem[] = [
    { href: "/genel-bakis", label: "Genel bakış", mobile: "bar" },
    { href: "/urunler", label: "Ürünler", mobile: "bar" },
    { href: "/veri", label: "Veri yükle", mobile: "bar" },
    { href: "/siparis-onerileri", label: "Sipariş önerileri", mobile: "bar" },
    { href: "/faturalar", label: "Alış faturaları", badge: draftCount ?? 0, mobile: "menu" },
    { href: "/giderler", label: "Giderler", mobile: "menu" },
    { href: "/uyarilar", label: "Uyarılar", badge: alertCount ?? 0, mobile: "menu" },
    { href: "/ayarlar", label: "Ayarlar", mobile: "menu" },
  ];

  const orgSwitcher =
    orgs.length > 1 ? (
      <form action={switchOrganization} className="flex gap-2">
        <label htmlFor="org-switch" className="sr-only">İşletme</label>
        <select id="org-switch" name="org" defaultValue={org.id}
          className="min-h-9 w-full rounded-md border border-ink-700 bg-ink-850 px-2 text-[13px] text-white lg:border-ink-700 max-lg:border-line-strong max-lg:bg-surface max-lg:text-text">
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <button className="min-h-9 rounded-md border border-ink-700 px-2 text-[13px] text-ink-300 hover:text-white max-lg:border-line-strong max-lg:text-text">Geç</button>
      </form>
    ) : (
      <p className="truncate text-[13px] text-ink-300 max-lg:text-muted" title={org.name}>{org.name}</p>
    );

  return (
    <AppShell
      nav={nav}
      orgName={org.name}
      orgSwitcher={orgSwitcher}
      userEmail={userEmail}
      signOut={
        <form action={signOut}>
          <button className="text-[13px] text-accent hover:underline lg:text-ink-300 lg:hover:text-white">Çıkış yap</button>
        </form>
      }
    >
      {children}
    </AppShell>
  );
}
