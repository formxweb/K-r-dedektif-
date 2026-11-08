import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { dec, sum } from "@/lib/domain/decimal";
import { marginPct, markupPct, suggestedPriceKeepingMargin } from "@/lib/domain/margin";
import { formatDate, formatDateShort, formatQty } from "@/lib/domain/format";
import { addDays, istToday } from "@/lib/domain/dates";
import { Badge, Callout, DefList, EmptyState, Money, Page, PageHeader, Panel, Pct, Qty, Section, Table, TableFrame, Tabs, Td, Th } from "@/components/ui";
import { QtyBars } from "@/components/charts";
import { voidMovement, deleteUnit } from "@/server/products";
import { MovementForm, ProductForm, SupplierForm, UnitForm, VatForm } from "./forms";

export const metadata: Metadata = { title: "Ürün" };

const TYPE_LABEL: Record<string, string> = {
  opening: "Açılış stoğu", purchase: "Alış", sale: "Satış", customer_return: "Müşteri iadesi", supplier_return: "Tedarikçiye iade",
  waste: "Fire", spoilage: "Bozulma", count_adjustment: "Sayım farkı", cost_adjustment: "Maliyet düzeltmesi",
};

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sekme?: string }> }) {
  const { id } = await params;
  const tab = (await searchParams).sekme ?? "ozet";
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data: p } = await supabase.from("product_overview").select("*").eq("id", id).eq("organization_id", org.id).maybeSingle();
  if (!p) notFound();

  const sale = p.sale_price_gross as string | null;
  const vat = p.vat_rate as string | null;
  const avg = p.avg_cost as string | null;
  const last = p.last_purchase_cost as string | null;
  const margin = sale && vat && avg ? marginPct(sale, vat, avg) : null;
  const markup = sale && vat && avg ? markupPct(sale, vat, avg) : null;
  const replMargin = sale && vat && last ? marginPct(sale, vat, last) : null;
  const neg = p.stock_qty && dec(p.stock_qty).isNegative();

  const tabs = [
    { key: "ozet", label: "Özet", href: `/urunler/${id}` },
    { key: "hareketler", label: "Stok hareketleri", href: `/urunler/${id}?sekme=hareketler` },
    { key: "birimler", label: "Birim, KDV, tedarikçi", href: `/urunler/${id}?sekme=birimler` },
    { key: "bilgiler", label: "Ürün bilgileri", href: `/urunler/${id}?sekme=bilgiler` },
  ];

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: "/urunler", label: "Ürünler" }]}
        title={p.name}
        meta={<>
          {!p.is_active && <Badge>Pasif</Badge>}
          {p.barcode && <span className="num">Barkod {p.barcode}</span>}
          {p.code && <span className="num">Kod {p.code}</span>}
          <span>Birim: {p.base_unit}</span>
          {p.category_name && <span>{p.category_name}</span>}
        </>}
      />
      <DefList items={[
        { label: "Stok", value: p.stock_qty === null ? "—" : <span className={neg ? "text-neg" : ""}>{formatQty(p.stock_qty, p.base_unit)}</span> },
        { label: "Ortalama maliyet", value: avg ? <Money value={avg} /> : "bilinmiyor", hint: "KDV hariç, hareketli ağırlıklı" },
        { label: "Son alış fiyatı", value: last ? <Money value={last} /> : "—", hint: p.last_purchase_at ? formatDateShort(p.last_purchase_at) : "kâr hesabında kullanılmaz" },
        { label: "Satış fiyatı", value: sale ? <Money value={sale} /> : "—", hint: p.sale_price_date ? `KDV dahil · ${formatDateShort(p.sale_price_date)}` : "KDV dahil" },
        { label: "Marj", value: margin ? <Pct value={margin} className={margin.lt(0) ? "text-neg" : ""} /> : "—", hint: markup ? `maliyet üstü %${markup.toDecimalPlaces(1).toString().replace(".", ",")}` : "satış fiyatı üzerinden" },
        { label: "Stok değeri", value: <Money value={p.stock_value} />, hint: "stok × ortalama maliyet" },
      ]} />
      {neg && <div className="mt-4"><Callout tone="warn" title="Stok eksi görünüyor">Satılan miktar, kayıtlı alış ve açılış stoğundan fazla. Eksik alış faturası olabilir veya sayım gerekiyor. “Stok hareketleri” sekmesinden sayım girebilirsiniz.</Callout></div>}
      {replMargin && margin && replMargin.lt(margin.minus(org.margin_alert_threshold_pts)) && sale && avg && last && (
        <div className="mt-4"><Callout tone="warn" title="Son alış fiyatıyla marj daha düşük">
          Bir sonraki mal son alış fiyatından gelecek: o fiyatla marj <Pct value={replMargin} />. Mevcut marjı korumak için önerilen raf fiyatı <Money value={suggestedPriceKeepingMargin(sale, avg, last, org.price_rounding_step)} />.
        </Callout></div>
      )}

      <div className="mt-6"><Tabs items={tabs} current={tab} /></div>
      {tab === "ozet" && <SummaryTab id={id} unit={p.base_unit} />}
      {tab === "hareketler" && <MovementsTab id={id} unit={p.base_unit} closedThrough={org.closed_through} />}
      {tab === "birimler" && <UnitsTab id={id} orgId={org.id} unit={p.base_unit} />}
      {tab === "bilgiler" && (
        <Panel className="max-w-[680px]">
          <ProductForm product={{ id, name: p.name, barcode: p.barcode, code: p.code, base_unit: p.base_unit, shelf_life_days: p.shelf_life_days, category: p.category_name, is_active: p.is_active }} />
        </Panel>
      )}
    </Page>
  );
}

async function SummaryTab({ id, unit }: { id: string; unit: string }) {
  const supabase = await createClient();
  const since = addDays(istToday(), -26 * 7);
  const [summaries, receipts, costs] = await Promise.all([
    supabase.from("sales_period_summaries").select("period_start, period_end, qty::text, net_amount::text, total_cost::text, cost_known").eq("product_id", id).eq("status", "active").gte("period_end", since).order("period_end"),
    supabase.from("sale_items").select("sold_at, qty::text").eq("product_id", id).eq("status", "active").gte("sold_at", since).order("sold_at").limit(10000),
    supabase.rpc("product_cost_history", { p_product: id }),
  ]);
  const s = must(summaries);
  const r = must(receipts);
  const c = must(costs) as Array<{ occurred_at: string; movement_type: string; qty: string; unit_cost: string | null; avg_cost_after: string | null; stock_after: string; invoice_no: string | null; supplier: string | null }>;

  // Grafik: özetler kendi dönemleriyle; fişler haftalık
  const bars: Array<{ label: string; qty: string }> = s.map((x) => ({ label: formatDateShort(x.period_end).slice(0, 5), qty: x.qty }));
  if (r.length) {
    const weeks = new Map<string, string[]>();
    for (const it of r) {
      const d = it.sold_at.slice(0, 10);
      const wk = addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
      weeks.set(wk, [...(weeks.get(wk) ?? []), it.qty]);
    }
    for (const [wk, qs] of [...weeks.entries()].sort()) bars.push({ label: formatDateShort(wk).slice(0, 5), qty: sum(qs).toString() });
  }
  const totalNet = sum(s.map((x) => x.net_amount));
  const totalQty = sum([...s.map((x) => x.qty), ...r.map((x) => x.qty)]);

  return (
    <div className="flex flex-col gap-6">
      <Section title="Satışlar (son 26 hafta)" description={bars.length ? `Toplam ${formatQty(totalQty, unit)}${s.length ? ` · dönem raporlarında net ${totalNet.toFixed(2).replace(".", ",")} ₺` : ""}` : undefined}>
        <Panel>{bars.length ? <QtyBars data={bars} unit={unit} /> : <EmptyState title="Bu ürün için satış verisi yok">Satış raporu yüklendiğinde burada görünür.</EmptyState>}</Panel>
      </Section>
      <Section title="Maliyet geçmişi" description="Açılış ve alışlar; her alıştan sonra ortalama maliyet yeniden hesaplanır.">
        <TableFrame>
          {c.length === 0 ? <EmptyState title="Maliyet kaydı yok">Açılış stoğu veya alış faturası yüklendiğinde oluşur.</EmptyState> : (
            <Table>
              <thead><tr><Th>Tarih</Th><Th>Kaynak</Th><Th align="right">Miktar</Th><Th align="right">Birim maliyet</Th><Th align="right">Sonra ortalama</Th></tr></thead>
              <tbody>
                {[...c].reverse().map((x, i) => (
                  <tr key={i}>
                    <Td className="num">{formatDateShort(x.occurred_at)}</Td>
                    <Td>{x.movement_type === "opening" ? "Açılış stoğu" : <>{x.supplier ?? "Alış"}{x.invoice_no && <span className="text-muted"> · {x.invoice_no}</span>}</>}</Td>
                    <Td align="right"><Qty value={x.movement_type === "opening" ? x.stock_after : x.qty} unit={unit} /></Td>
                    <Td align="right"><Money value={x.unit_cost} decimals={4} /></Td>
                    <Td align="right"><Money value={x.avg_cost_after} decimals={4} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableFrame>
      </Section>
    </div>
  );
}

async function MovementsTab({ id, unit, closedThrough }: { id: string; unit: string; closedThrough: string | null }) {
  const supabase = await createClient();
  const rows = must(await supabase.from("inventory_movements")
    .select("id, occurred_at, movement_type, qty::text, total_cost::text, cost_known, stock_after::text, avg_cost_after::text, source_type, note, import_job_id")
    .eq("product_id", id).is("voided_at", null).order("occurred_at", { ascending: false }).order("seq", { ascending: false }).limit(300));
  return (
    <div className="flex flex-col gap-6">
      <Section title="Fire, bozulma, iade veya sayım ekle" description="Sayımda, saydığınız miktarı yazın; fark otomatik hesaplanır.">
        <Panel><MovementForm productId={id} unit={unit} today={istToday()} minDate={closedThrough ? addDays(closedThrough, 1) : undefined} /></Panel>
      </Section>
      <Section title="Hareketler" description="Stok, hareketlerin toplamıdır. Maliyetler KDV hariçtir.">
        <TableFrame>
          {rows.length === 0 ? <EmptyState title="Hareket yok">Ürün listesi, satış raporu veya fatura yüklendiğinde oluşur.</EmptyState> : (
            <Table>
              <thead><tr><Th>Tarih</Th><Th>Tür</Th><Th align="right">Miktar</Th><Th align="right" className="hidden sm:table-cell">Maliyet</Th><Th align="right">Sonra stok</Th><Th className="hidden md:table-cell">Kaynak</Th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <Td className="num whitespace-nowrap">{formatDateShort(m.occurred_at)}</Td>
                    <Td>{TYPE_LABEL[m.movement_type]}{m.note && <div className="text-[12px] text-muted">{m.note}</div>}</Td>
                    <Td align="right"><Qty value={m.qty} unit={unit} className={dec(m.qty).isNegative() ? "text-neg" : ""} /></Td>
                    <Td align="right" className="hidden sm:table-cell">{m.cost_known ? <Money value={m.total_cost ? dec(m.total_cost).abs().toString() : null} /> : <span className="text-faint">bilinmiyor</span>}</Td>
                    <Td align="right"><Qty value={m.stock_after} /></Td>
                    <Td className="hidden md:table-cell">
                      {m.source_type === "manual" ? (
                        <form action={voidMovement} className="inline"><input type="hidden" name="movement_id" value={m.id} /><input type="hidden" name="product_id" value={id} /><button className="text-[13px] text-neg hover:underline">Elle girildi · iptal et</button></form>
                      ) : m.import_job_id ? <Link href={`/veri/${m.import_job_id}`} className="text-[13px] text-accent hover:underline">Aktarım</Link> : <span className="text-[13px] text-muted">Sistem</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableFrame>
      </Section>
    </div>
  );
}

async function UnitsTab({ id, orgId, unit }: { id: string; orgId: string; unit: string }) {
  const supabase = await createClient();
  const [units, rates, links, suppliers] = await Promise.all([
    supabase.from("product_units").select("id, name, factor::text, barcode").eq("product_id", id).order("name"),
    supabase.from("tax_rates").select("id, rate::text, valid_from, valid_to").eq("product_id", id).order("valid_from", { ascending: false }),
    supabase.from("product_suppliers").select("id, is_primary, order_unit_name, order_unit_factor::text, min_order_qty::text, suppliers(id, name)").eq("product_id", id),
    supabase.from("suppliers").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
  ]);
  const u = must(units), t = must(rates), l = must(links), sp = must(suppliers);
  const primary = l.find((x) => x.is_primary);
  return (
    <div className="flex flex-col gap-6">
      <Section title="Alış birimleri" description={`Fatura koli/paket ile gelse bile stok ve maliyet ${unit} cinsinden tutulur.`}>
        <TableFrame>
          {u.length === 0 ? <EmptyState title="Tanımlı alış birimi yok">Fatura eşleştirirken girilen koli/paket katsayıları burada görünür.</EmptyState> : (
            <Table>
              <thead><tr><Th>Birim</Th><Th align="right">Karşılığı</Th><Th className="hidden sm:table-cell">Barkod</Th><Th align="right"> </Th></tr></thead>
              <tbody>{u.map((x) => (
                <tr key={x.id}>
                  <Td>1 {x.name}</Td><Td align="right" className="num">{formatQty(x.factor, unit)}</Td><Td className="hidden num sm:table-cell">{x.barcode ?? "—"}</Td>
                  <Td align="right"><form action={deleteUnit}><input type="hidden" name="unit_id" value={x.id} /><input type="hidden" name="product_id" value={id} /><button className="text-[13px] text-neg hover:underline">Kaldır</button></form></Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </TableFrame>
        <div className="mt-3"><Panel><UnitForm productId={id} unit={unit} /></Panel></div>
      </Section>
      <Section title="KDV oranı" description="Oranlar tarih aralıklıdır. Değişiklik yeni aktarımları etkiler; geçmiş kayıtlar değişmez.">
        <TableFrame>
          <Table>
            <thead><tr><Th>Oran</Th><Th>Başlangıç</Th><Th>Bitiş</Th></tr></thead>
            <tbody>{t.length === 0 ? <tr><Td colSpan={3} className="text-muted">Tanımlı oran yok — satışlar KDV hariçe çevrilemez.</Td></tr> : t.map((x) => (
              <tr key={x.id}><Td><Pct value={x.rate} decimals={0} /></Td><Td className="num">{x.valid_from <= "2000-01-01" ? "ilk kayıt" : formatDate(x.valid_from)}</Td><Td className="num">{x.valid_to ? formatDate(x.valid_to) : "devam ediyor"}</Td></tr>
            ))}</tbody>
          </Table>
        </TableFrame>
        <div className="mt-3"><Panel><VatForm productId={id} today={istToday()} /></Panel></div>
      </Section>
      <Section title="Tedarikçi ve sipariş" description="Sipariş önerisi bu tedarikçinin teslim süresi, koli içi adedi ve minimum sipariş miktarını kullanır.">
        <Panel>
          <SupplierForm productId={id} unit={unit} suppliers={sp} current={primary ? {
            supplier_id: (primary.suppliers as unknown as { id: string }).id, order_unit_name: primary.order_unit_name, order_unit_factor: primary.order_unit_factor, min_order_qty: primary.min_order_qty,
          } : null} />
        </Panel>
      </Section>
    </div>
  );
}
