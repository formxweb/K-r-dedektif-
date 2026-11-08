import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { formatDateShort } from "@/lib/domain/format";
import { EmptyState, Page, PageHeader, Pagination, TableFrame, Tabs } from "@/components/ui";
import { AlertLine, type AlertRow } from "@/components/alerts";

export const metadata: Metadata = { title: "Uyarılar" };

async function dismissAlert(form: FormData) {
  "use server";
  const supabase = await createClient();
  const all = form.get("all") === "1";
  const { org } = await requireOrg();
  if (all) await supabase.from("alerts").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("organization_id", org.id).eq("status", "open");
  else await supabase.from("alerts").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", String(form.get("id")));
  revalidatePath("/uyarilar");
  revalidatePath("/genel-bakis");
}

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ durum?: string; s?: string }> }) {
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const open = sp.durum !== "kapali";
  const page = Math.max(1, Number(sp.s ?? 1) || 1);
  const size = 30;
  const res = await supabase.from("alerts").select("id, alert_type, payload, product_id, created_at, status, products(name)", { count: "exact" })
    .eq("organization_id", org.id).in("status", open ? ["open"] : ["dismissed", "resolved"]).order("created_at", { ascending: false }).range((page - 1) * size, page * size - 1);
  const rows = must(res) as unknown as AlertRow[];
  return (
    <Page>
      <PageHeader title="Uyarılar" description="Marjı düşen ürünler, tutmayan fatura toplamları ve geçmiş kârı değiştiren işlemler."
        actions={open && rows.length > 0 ? <form action={dismissAlert}><input type="hidden" name="all" value="1" /><button className="min-h-10 rounded-md border border-line-strong bg-surface px-3 text-[14px] hover:bg-subtle">Tümünü okundu say</button></form> : undefined} />
      <Tabs current={open ? "open" : "closed"} items={[{ key: "open", label: "Açık", href: "/uyarilar" }, { key: "closed", label: "Kapatılan", href: "/uyarilar?durum=kapali" }]} />
      <TableFrame footer={<Pagination page={page} pageSize={size} total={res.count ?? 0} hrefFor={(p) => `/uyarilar?${open ? "" : "durum=kapali&"}s=${p}`} />}>
        {rows.length === 0 ? <EmptyState title={open ? "Açık uyarı yok" : "Kapatılan uyarı yok"}>{open ? "Yeni bir alış faturası işlendiğinde alış fiyatı artan ürünler burada görünür." : null}</EmptyState> : (
          <ul className="divide-y divide-line">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                <AlertLine alert={a} />
                <div className="flex shrink-0 items-center gap-3 text-[12.5px] text-muted">
                  <span className="num">{formatDateShort(a.created_at)}</span>
                  {open && <form action={dismissAlert}><input type="hidden" name="id" value={a.id} /><button className="min-h-9 rounded-md border border-line-strong px-2.5 text-[13px] text-text hover:bg-subtle">Okundu</button></form>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </TableFrame>
    </Page>
  );
}
