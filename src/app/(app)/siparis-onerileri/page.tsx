import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { dec, sum } from "@/lib/domain/decimal";
import { addDays, istToday } from "@/lib/domain/dates";
import { formatDate, formatDateShort, formatQty } from "@/lib/domain/format";
import { fetchAll } from "@/lib/data/common";
import { Badge, Callout, EmptyState, Money, Page, PageHeader, Panel, Section, Table, TableFrame, Tabs, Td, Th, buttonClass } from "@/components/ui";
import { CopyButton } from "@/components/client";
import { markOrdered } from "@/server/forecast";
import { RunForecastButton } from "./run-button";

export const metadata: Metadata = { title: "Sipariş önerileri" };

const CONF = { high: { l: "Güven: yüksek", t: "pos" as const }, medium: { l: "Güven: orta", t: "info" as const }, low: { l: "Güven: düşük", t: "warn" as const }, insufficient: { l: "Yetersiz veri", t: "neutral" as const } };

interface Item {
  id: string; product_id: string; supplier_id: string | null; suggested_units: string; suggested_qty: string; order_unit_name: string | null; order_unit_factor: string | null;
  range_low_units: string | null; range_high_units: string | null; confidence: keyof typeof CONF; reason: string; ordered_at: string | null; inputs: { notes?: string[] };
  products: { name: string; base_unit: string } | null; suppliers: { name: string; phone: string | null } | null;
}

function unitText(i: Item, n: string): string {
  const f = dec(i.order_unit_factor ?? "1");
  if (f.gt(1) && i.order_unit_name) return `${n} ${i.order_unit_name.toLocaleLowerCase("tr-TR")}`;
  return formatQty(dec(n).times(f), i.products?.base_unit);
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ sekme?: string }> }) {
  const tab = (await searchParams).sekme === "olu-stok" ? "dead" : (await searchParams).sekme === "tumu" ? "all" : "orders";
  const { org } = await requireOrg();
  const supabase = await createClient();
  const run = (await supabase.from("forecast_runs").select("id, created_at, params, data_summary").eq("organization_id", org.id).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
  const tabs = [
    { key: "orders", label: "Sipariş listesi", href: "/siparis-onerileri" },
    { key: "all", label: "Tüm ürünler", href: "/siparis-onerileri?sekme=tumu" },
    { key: "dead", label: "Ölü stok", href: "/siparis-onerileri?sekme=olu-stok" },
  ];

  return (
    <Page>
      <PageHeader
        title="Sipariş önerileri"
        description="Kesin rakam değil, gerekçeli öneri: son haftaların satışı, eğilim, stok, teslim süresi ve koli içi adetten hesaplanır."
        meta={run ? <span>Son hesaplama: {formatDate(run.created_at)} · veri {formatDateShort(String((run.params as Record<string, string>).data_end))} tarihine kadar</span> : undefined}
        actions={<RunForecastButton label={run ? "Yeniden hesapla" : "Öneriyi hesapla"} />}
      />
      <Tabs items={tabs} current={tab} />
      {tab === "dead" ? <DeadStock orgId={org.id} days={org.dead_stock_days} /> : !run ? (
        <TableFrame><EmptyState title="Henüz öneri hesaplanmadı">En az 4 haftalık satış verisi yükledikten sonra “Öneriyi hesapla”ya basın. Tedarikçilerin teslim süresini ve ürünlerin koli içi adedini girmek öneriyi iyileştirir.</EmptyState></TableFrame>
      ) : <RunView runId={run.id} all={tab === "all"} />}
    </Page>
  );
}

async function RunView({ runId, all }: { runId: string; all: boolean }) {
  const supabase = await createClient();
  const items = await fetchAll<Item>((a, b) => {
    let q = supabase.from("forecast_items").select("id, product_id, supplier_id, suggested_units::text, suggested_qty::text, order_unit_name, order_unit_factor::text, range_low_units::text, range_high_units::text, confidence, reason, ordered_at, inputs, products(name, base_unit), suppliers(name, phone)").eq("run_id", runId);
    if (!all) q = q.gt("suggested_units", 0);
    return q.order("id").range(a, b);
  });
  const groups = new Map<string, Item[]>();
  for (const i of items) groups.set(i.supplier_id ?? "", [...(groups.get(i.supplier_id ?? "") ?? []), i]);
  const sorted = [...groups.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : (a[1][0]!.suppliers?.name ?? "").localeCompare(b[1][0]!.suppliers?.name ?? "", "tr")));
  const insufficient = all ? 0 : (await supabase.from("forecast_items").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("confidence", "insufficient")).count ?? 0;

  if (items.length === 0) {
    return <TableFrame><EmptyState title="Şu an sipariş gerekmiyor">Stoklar, teslim süresi ve sipariş aralığı boyunca yetecek görünüyor. “Tüm ürünler” sekmesinde her ürünün gerekçesini görebilirsiniz.</EmptyState></TableFrame>;
  }
  return (
    <div className="flex flex-col gap-6">
      {insufficient > 0 && <Callout tone="neutral">{insufficient} ürün için 4 haftadan az satış verisi var; bunlara öneri yapılmadı.</Callout>}
      {sorted.map(([sid, list]) => {
        const name = list[0]!.suppliers?.name ?? "Tedarikçisi belirsiz";
        const orderable = list.filter((i) => dec(i.suggested_units).gt(0));
        const text = `Merhaba, ${formatDateShort(istToday())} siparişimiz:\n` + orderable.map((i) => `- ${i.products?.name}: ${unitText(i, i.suggested_units)}`).join("\n") + "\nTeşekkürler.";
        const ordered = orderable.length > 0 && orderable.every((i) => i.ordered_at);
        return (
          <Section key={sid || "none"} title={name} description={sid ? `${orderable.length} ürün` : "Bu ürünlerin ana tedarikçisini ürün ekranından seçin."}
            actions={orderable.length > 0 && !all ? (
              <div className="flex flex-wrap gap-2">
                <CopyButton text={text} label="WhatsApp metnini kopyala" />
                {ordered ? <Badge tone="pos">Sipariş verildi</Badge> : (
                  <form action={markOrdered}><input type="hidden" name="run_id" value={runId} /><input type="hidden" name="supplier_id" value={sid} /><button className={buttonClass("secondary")}>Sipariş verdim</button></form>
                )}
              </div>
            ) : undefined}>
            <TableFrame>
              <Table>
                <thead><tr><Th>Ürün</Th><Th align="right">Öneri</Th><Th align="right" className="hidden sm:table-cell">Aralık</Th><Th className="hidden md:table-cell">Güven</Th></tr></thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id} className="align-top">
                      <Td>
                        <Link href={`/urunler/${i.product_id}`} className="font-medium text-accent hover:underline">{i.products?.name}</Link>
                        <p className="mt-0.5 max-w-[70ch] text-[13px] leading-snug text-muted">{i.reason}</p>
                        {(i.inputs?.notes ?? []).map((n) => <p key={n} className="text-[12.5px] text-warn">{n}</p>)}
                        <div className="mt-1 md:hidden"><Badge tone={CONF[i.confidence].t}>{CONF[i.confidence].l}</Badge></div>
                      </Td>
                      <Td align="right" className="whitespace-nowrap font-semibold">{dec(i.suggested_units).gt(0) ? unitText(i, i.suggested_units) : <span className="font-normal text-faint">yok</span>}</Td>
                      <Td align="right" className="hidden whitespace-nowrap text-muted sm:table-cell">{i.range_low_units && dec(i.range_high_units ?? "0").gt(0) ? `${i.range_low_units}–${i.range_high_units}${dec(i.order_unit_factor ?? "1").gt(1) && i.order_unit_name ? " " + i.order_unit_name.toLocaleLowerCase("tr-TR") : ""}` : "—"}</Td>
                      <Td className="hidden md:table-cell"><Badge tone={CONF[i.confidence].t}>{CONF[i.confidence].l}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          </Section>
        );
      })}
    </div>
  );
}

async function DeadStock({ orgId, days }: { orgId: string; days: number }) {
  const supabase = await createClient();
  const cutoff = addDays(istToday(), -days);
  const rows = must(await supabase.from("product_overview").select("id, name, base_unit, stock_qty, avg_cost, stock_value, last_sale_at, first_movement_at")
    .eq("organization_id", orgId).eq("is_active", true).gt("stock_sort", 0).or(`last_sale_at.is.null,last_sale_at.lt.${cutoff}`).lt("first_movement_at", cutoff)
    .order("value_sort", { ascending: false }).limit(500));
  const total = sum(rows.map((r) => r.stock_value));
  return (
    <Section title={`${days} gündür satılmayan ürünler`} description="Bu ürünlere bağlanan para (maliyetle). Süreyi Ayarlar'dan değiştirebilirsiniz.">
      <Panel className="mb-3"><p className="text-[14px] text-muted">Bağlı para</p><p className="num text-[26px] font-semibold"><Money value={total.toString()} /></p><p className="text-[13px] text-muted">{rows.length} ürün</p></Panel>
      <TableFrame>
        {rows.length === 0 ? <EmptyState title="Ölü stok yok" /> : (
          <Table>
            <thead><tr><Th>Ürün</Th><Th align="right">Stok</Th><Th align="right">Bağlı para</Th><Th className="hidden sm:table-cell">Son satış</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/urunler/${r.id}`} className="text-accent hover:underline">{r.name}</Link></Td>
                <Td align="right" className="num">{formatQty(r.stock_qty, r.base_unit)}</Td>
                <Td align="right">{r.stock_value ? <Money value={r.stock_value} /> : <span className="text-faint">maliyet yok</span>}</Td>
                <Td className="hidden num text-muted sm:table-cell">{r.last_sale_at ? formatDateShort(r.last_sale_at) : "hiç satılmadı"}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </TableFrame>
    </Section>
  );
}
