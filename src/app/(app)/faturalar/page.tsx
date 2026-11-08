import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { formatDate } from "@/lib/domain/format";
import { Badge, EmptyState, LinkButton, Money, Page, PageHeader, Pagination, Table, TableFrame, Tabs, Td, Th, Input } from "@/components/ui";

export const metadata: Metadata = { title: "Alış faturaları" };

const STATUS = {
  draft: { label: "Eşleştirme bekliyor", tone: "warn" as const },
  posted: { label: "İşlendi", tone: "pos" as const },
  reversed: { label: "Geri alındı", tone: "neutral" as const },
  cancelled: { label: "İptal", tone: "neutral" as const },
};

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ durum?: string; q?: string; s?: string }> }) {
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const status = sp.durum && sp.durum in STATUS ? sp.durum : "all";
  const page = Math.max(1, Number(sp.s ?? 1) || 1);
  const size = 25;
  let query = supabase
    .from("purchase_invoices")
    .select("id, invoice_no, invoice_date, status, total_mismatch, calc_total_excl_vat::text, calc_total_incl_vat::text, suppliers(name)", { count: "exact" })
    .eq("organization_id", org.id)
    .neq("status", "cancelled");
  if (status !== "all") query = query.eq("status", status);
  if (sp.q) query = query.ilike("invoice_no", `%${sp.q.replace(/[%_]/g, "")}%`);
  const res = await query.order("invoice_date", { ascending: false }).order("created_at", { ascending: false }).range((page - 1) * size, page * size - 1);
  const rows = must(res);
  const counts = Object.fromEntries(
    await Promise.all(["draft", "posted"].map(async (s) => [s, (await supabase.from("purchase_invoices").select("id", { count: "exact", head: true }).eq("organization_id", org.id).eq("status", s)).count ?? 0])),
  );
  const href = (o: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const m = { durum: status === "all" ? undefined : status, q: sp.q, ...o };
    Object.entries(m).forEach(([k, v]) => v !== undefined && v !== "" && u.set(k, String(v)));
    return `/faturalar${u.size ? `?${u}` : ""}`;
  };

  return (
    <Page>
      <PageHeader title="Alış faturaları" description="Tedarikçi faturaları maliyetin kaynağıdır. Her satır bir ürünle eşleşir; onaylanan eşleşme bir daha sorulmaz."
        actions={<LinkButton href="/veri" variant="primary">Fatura yükle</LinkButton>} />
      <Tabs current={status} items={[
        { key: "all", label: "Tümü", href: href({ durum: undefined, s: undefined }) },
        { key: "draft", label: "Eşleştirme bekleyen", href: href({ durum: "draft", s: undefined }), count: counts.draft },
        { key: "posted", label: "İşlenen", href: href({ durum: "posted", s: undefined }), count: counts.posted },
      ]} />
      <TableFrame
        toolbar={
          <form className="flex w-full max-w-md items-center gap-2" role="search">
            {status !== "all" && <input type="hidden" name="durum" value={status} />}
            <label htmlFor="q" className="text-[13px] font-medium text-muted">Ara</label>
            <Input id="q" name="q" defaultValue={sp.q} placeholder="Fatura no" className="min-h-9" />
          </form>
        }
        footer={<Pagination page={page} pageSize={size} total={res.count ?? 0} hrefFor={(p) => href({ s: p })} />}
      >
        {rows.length === 0 ? (
          <EmptyState title={sp.q || status !== "all" ? "Bu filtreyle fatura yok" : "Henüz alış faturası yok"} action={!sp.q && status === "all" ? <LinkButton href="/veri" variant="primary">e-Fatura XML yükle</LinkButton> : undefined}>
            {!sp.q && status === "all" ? "Tedarikçilerinizden gelen e-Fatura XML dosyalarını yükleyin. Maliyet ve marj uyarıları faturalardan hesaplanır." : null}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Fatura</Th><Th className="hidden sm:table-cell">Tedarikçi</Th><Th align="right" className="hidden md:table-cell">KDV hariç</Th><Th align="right">Toplam</Th><Th>Durum</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-subtle">
                  <Td>
                    <Link href={`/faturalar/${r.id}`} className="font-medium text-accent hover:underline">{r.invoice_no}</Link>
                    <div className="text-[12.5px] text-muted">{formatDate(r.invoice_date)}<span className="sm:hidden"> · {(r.suppliers as unknown as { name: string })?.name}</span></div>
                  </Td>
                  <Td className="hidden sm:table-cell">{(r.suppliers as unknown as { name: string })?.name}</Td>
                  <Td align="right" className="hidden md:table-cell"><Money value={r.calc_total_excl_vat} /></Td>
                  <Td align="right"><Money value={r.calc_total_incl_vat} /></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={STATUS[r.status as keyof typeof STATUS].tone}>{STATUS[r.status as keyof typeof STATUS].label}</Badge>
                      {r.total_mismatch && <Badge tone="neg">Toplam farkı</Badge>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </TableFrame>
    </Page>
  );
}
