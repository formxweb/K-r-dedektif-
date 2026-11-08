import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { dec } from "@/lib/domain/decimal";
import { marginPct } from "@/lib/domain/margin";
import { formatDateShort } from "@/lib/domain/format";
import { addDays, istToday } from "@/lib/domain/dates";
import { Badge, EmptyState, Input, LinkButton, Money, Page, PageHeader, Pagination, Pct, Qty, Select, Table, TableFrame, Td, Th, buttonClass } from "@/components/ui";

export const metadata: Metadata = { title: "Ürünler" };

const FILTERS = {
  all: "Tüm ürünler",
  in_stock: "Stokta olanlar",
  out: "Stoğu bitenler",
  negative: "Stoğu eksi görünenler",
  dead: "Ölü stok (satılmayan)",
  no_cost: "Maliyeti bilinmeyenler",
  passive: "Pasif ürünler",
} as const;
const SORTS = {
  name: "Ada göre",
  value_desc: "Stok değeri (yüksekten)",
  stock_desc: "Stok miktarı (çoktan)",
  stock_asc: "Stok miktarı (azdan)",
  last_sale: "Son satış (eskiden)",
} as const;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; f?: string; sira?: string; kat?: string; s?: string }> }) {
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const filter = (sp.f && sp.f in FILTERS ? sp.f : "all") as keyof typeof FILTERS;
  const sort = (sp.sira && sp.sira in SORTS ? sp.sira : "name") as keyof typeof SORTS;
  const page = Math.max(1, Number(sp.s ?? 1) || 1);
  const size = 50;

  let q = supabase
    .from("product_overview")
    .select("id, name, barcode, code, base_unit, category_name, is_active, stock_qty, avg_cost, stock_value, last_purchase_cost, sale_price_gross, vat_rate, last_sale_at, first_movement_at", { count: "exact" })
    .eq("organization_id", org.id);
  if (filter !== "passive") q = q.eq("is_active", true);
  else q = q.eq("is_active", false);
  if (sp.q) {
    const t = sp.q.replace(/[%_,()"\\]/g, " ").trim();
    q = q.or(`name.ilike."%${t}%",barcode.eq."${t}",code.eq."${t}"`);
  }
  if (sp.kat) q = q.eq("category_id", sp.kat);
  const deadBefore = addDays(istToday(), -org.dead_stock_days);
  if (filter === "in_stock") q = q.gt("stock_sort", 0);
  if (filter === "out") q = q.eq("stock_sort", 0);
  if (filter === "negative") q = q.lt("stock_sort", 0);
  if (filter === "dead") q = q.gt("stock_sort", 0).or(`last_sale_at.is.null,last_sale_at.lt.${deadBefore}`).lt("first_movement_at", deadBefore);
  if (filter === "no_cost") q = q.is("avg_cost", null).not("stock_qty", "is", null);
  if (sort === "name") q = q.order("name");
  if (sort === "value_desc") q = q.order("value_sort", { ascending: false }).order("name");
  if (sort === "stock_desc") q = q.order("stock_sort", { ascending: false }).order("name");
  if (sort === "stock_asc") q = q.order("stock_sort", { ascending: true }).order("name");
  if (sort === "last_sale") q = q.order("last_sale_at", { ascending: true, nullsFirst: true }).order("name");
  const res = await q.range((page - 1) * size, page * size - 1);
  const rows = must(res);
  const categories = must(await supabase.from("categories").select("id, name").eq("organization_id", org.id).order("name"));
  const anyProducts = sp.q || filter !== "all" || sp.kat ? true : (res.count ?? 0) > 0;

  const href = (o: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const m = { q: sp.q, f: filter === "all" ? undefined : filter, sira: sort === "name" ? undefined : sort, kat: sp.kat, ...o };
    Object.entries(m).forEach(([k, v]) => v !== undefined && v !== "" && u.set(k, String(v)));
    return `/urunler${u.size ? `?${u}` : ""}`;
  };
  const activeChips = [
    filter !== "all" && { label: FILTERS[filter], clear: href({ f: undefined, s: undefined }) },
    sp.kat && { label: categories.find((c) => c.id === sp.kat)?.name ?? "Kategori", clear: href({ kat: undefined, s: undefined }) },
  ].filter(Boolean) as Array<{ label: string; clear: string }>;

  return (
    <Page width="wide">
      <PageHeader title="Ürünler" description="Stok, ortalama maliyet ve güncel marj. Marj, son yüklenen satış fiyatı ile hareketli ortalama maliyetten hesaplanır."
        actions={<LinkButton href="/veri" variant="secondary">Ürün listesi yükle</LinkButton>} />
      <TableFrame
        toolbar={
          <form className="flex w-full flex-wrap items-end gap-2" role="search">
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <label htmlFor="q" className="text-[12.5px] font-medium text-muted">Ara</label>
              <Input id="q" name="q" defaultValue={sp.q} placeholder="Ürün adı, barkod veya stok kodu" className="min-h-9" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f" className="text-[12.5px] font-medium text-muted">Filtre</label>
              <Select id="f" name="f" defaultValue={filter} className="min-h-9 w-auto">
                {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </div>
            {categories.length > 0 && (
              <div className="flex flex-col gap-1">
                <label htmlFor="kat" className="text-[12.5px] font-medium text-muted">Kategori</label>
                <Select id="kat" name="kat" defaultValue={sp.kat ?? ""} className="min-h-9 w-auto">
                  <option value="">Tümü</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor="sira" className="text-[12.5px] font-medium text-muted">Sıralama</label>
              <Select id="sira" name="sira" defaultValue={sort} className="min-h-9 w-auto">
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </div>
            <button className={buttonClass("primary", "min-h-9")}>Uygula</button>
          </form>
        }
        footer={<Pagination page={page} pageSize={size} total={res.count ?? 0} hrefFor={(p) => href({ s: p })} />}
      >
        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[13px]">
            {activeChips.map((c) => (
              <Link key={c.label} href={c.clear} className="inline-flex items-center gap-1 rounded-sm border border-line-strong px-2 py-0.5 hover:bg-subtle">{c.label} <span aria-hidden>×</span><span className="sr-only">filtresini kaldır</span></Link>
            ))}
            <Link href="/urunler" className="text-accent hover:underline">Temizle</Link>
          </div>
        )}
        {rows.length === 0 ? (
          anyProducts ? (
            <EmptyState title="Bu filtreyle ürün bulunamadı">Aramayı veya filtreyi değiştirin.</EmptyState>
          ) : (
            <EmptyState title="Henüz ürün yok" action={<LinkButton href="/veri" variant="primary">Ürün listesini yükle</LinkButton>}>
              POS programınızdan ürün/stok listesini dışa aktarıp yükleyin. Barkod, ad, fiyat, KDV ve stok bilgileri buradan gelir.
            </EmptyState>
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Ürün</Th>
                <Th align="right">Stok</Th>
                <Th align="right" className="hidden md:table-cell">Ort. maliyet</Th>
                <Th align="right" className="hidden md:table-cell">Satış fiyatı</Th>
                <Th align="right">Marj</Th>
                <Th align="right" className="hidden lg:table-cell">Stok değeri</Th>
                <Th className="hidden lg:table-cell">Son satış</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = r.sale_price_gross && r.avg_cost && r.vat_rate ? marginPct(r.sale_price_gross, r.vat_rate, r.avg_cost) : null;
                const neg = r.stock_qty && dec(r.stock_qty).isNegative();
                return (
                  <tr key={r.id} className="hover:bg-subtle">
                    <Td>
                      <Link href={`/urunler/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</Link>
                      <div className="num text-[12px] text-muted">{[r.barcode, r.category_name].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td align="right">
                      {r.stock_qty === null ? <span className="text-faint">—</span> : <Qty value={r.stock_qty} unit={r.base_unit} className={neg ? "text-neg" : ""} />}
                    </Td>
                    <Td align="right" className="hidden md:table-cell">{r.avg_cost ? <Money value={r.avg_cost} /> : <Badge tone="warn">bilinmiyor</Badge>}</Td>
                    <Td align="right" className="hidden md:table-cell"><Money value={r.sale_price_gross} /></Td>
                    <Td align="right">{m ? <Pct value={m} className={m.lt(0) ? "text-neg" : m.lt(10) ? "text-warn" : ""} /> : <span className="text-faint">—</span>}</Td>
                    <Td align="right" className="hidden lg:table-cell"><Money value={r.stock_value} /></Td>
                    <Td className="hidden lg:table-cell num text-muted">{r.last_sale_at ? formatDateShort(r.last_sale_at) : "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </TableFrame>
    </Page>
  );
}
