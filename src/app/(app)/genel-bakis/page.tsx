import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient, type Supa } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { dec } from "@/lib/domain/decimal";
import { buildPnl, type PnlRaw } from "@/lib/domain/pnl";
import { addMonths, istToday, monthEnd, monthStart } from "@/lib/domain/dates";
import { formatMonth, formatQty, formatTL } from "@/lib/domain/format";
import { Callout, EmptyState, LinkButton, Money, NOTE_MGMT, Page, Panel, Pct, Section, Table, TableFrame, Td, Th, buttonClass, cx } from "@/components/ui";
import { MonthlyPnlChart } from "@/components/charts";
import { AlertLine } from "@/components/alerts";

export const metadata: Metadata = { title: "Genel bakış" };

async function pnlFor(supabase: Supa, org: string, m: string): Promise<PnlRaw> {
  const to = monthEnd(m) < istToday() ? monthEnd(m) : istToday();
  return must(await supabase.rpc("pnl_summary", { p_org: org, p_from: m, p_to: to })) as PnlRaw;
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ ay?: string }> }) {
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const current = monthStart(istToday());
  const m = sp.ay && /^\d{4}-\d{2}$/.test(sp.ay) && `${sp.ay}-01` <= current ? `${sp.ay}-01` : current;

  const { count: productCount } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", org.id);
  if (!productCount) return <Onboarding />;

  const months = Array.from({ length: 6 }, (_, i) => addMonths(m, i - 5));
  const [raws, profitRes, alertsRes, runRes] = await Promise.all([
    Promise.all(months.map((x) => pnlFor(supabase, org.id, x))),
    supabase.rpc("product_profit", { p_org: org.id, p_from: m, p_to: monthEnd(m) }),
    supabase.from("alerts").select("id, alert_type, payload, product_id, created_at, products(name)").eq("organization_id", org.id).eq("status", "open").order("created_at", { ascending: false }).limit(5),
    supabase.from("forecast_runs").select("id, created_at").eq("organization_id", org.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const pnl = buildPnl(raws[raws.length - 1]!);
  const prev = buildPnl(raws[raws.length - 2]!);
  const profits = (must(profitRes) as Array<{ product_id: string; name: string; base_unit: string; qty: string; net_sales: string; cogs: string; gross_profit: string; margin_pct: string | null; unknown_cost_net: string }>)
    .filter((p) => dec(p.net_sales).gt(0));
  const top = [...profits].sort((a, b) => dec(b.gross_profit).cmp(dec(a.gross_profit))).slice(0, 10);
  const bottom = [...profits].sort((a, b) => dec(a.gross_profit).cmp(dec(b.gross_profit))).slice(0, 10);
  const alerts = must(alertsRes);

  // Kritik stok: son öneri çalıştırmasında teslim süresi içinde bitecek ürünler; yoksa satılan ama stoğu bitenler
  let critical: Array<{ id: string; name: string; stock: string | null; unit: string; note: string }> = [];
  if (runRes.data) {
    const items = must(await supabase.from("forecast_items").select("product_id, stock_on_hand::text, weekly_demand::text, inputs, products(name, base_unit)").eq("run_id", runRes.data.id).not("weekly_demand", "is", null).limit(2000));
    critical = items
      .map((i) => {
        const lead = Number((i.inputs as Record<string, unknown>)?.lead_time_days ?? 2);
        const daily = dec(i.weekly_demand ?? "0").div(7);
        const days = daily.gt(0) ? dec(i.stock_on_hand ?? "0").div(daily) : null;
        const p = i.products as unknown as { name: string; base_unit: string };
        return { id: i.product_id, name: p.name, stock: i.stock_on_hand, unit: p.base_unit, days, lead };
      })
      .filter((x) => x.days !== null && x.days.lte(x.lead + 1))
      .sort((a, b) => a.days!.cmp(b.days!))
      .slice(0, 10)
      .map((x) => ({ id: x.id, name: x.name, stock: x.stock, unit: x.unit, note: x.days!.lte(0) ? "bitti" : `≈ ${x.days!.toDecimalPlaces(0).toString()} gün yeter` }));
  } else {
    const outs = must(await supabase.from("product_overview").select("id, name, stock_qty, base_unit, last_sale_at").eq("organization_id", org.id).eq("is_active", true).lte("stock_sort", 0).not("last_sale_at", "is", null).order("last_sale_at", { ascending: false }).limit(10));
    critical = outs.map((o) => ({ id: o.id, name: o.name, stock: o.stock_qty, unit: o.base_unit, note: "stok yok, satılıyor" }));
  }

  const chart = months.map((x, i) => {
    const p = buildPnl(raws[i]!);
    return { label: formatMonth(x).split(" ")[0]!.slice(0, 3), sales: p.netSalesKnownCost.toString(), gross: p.grossProfit.toString(), operating: p.operatingResult.toString() };
  });
  const opDelta = prev.hasData ? pnl.operatingResult.minus(prev.operatingResult) : null;
  const monthOptions = Array.from({ length: 18 }, (_, i) => addMonths(current, -i));

  return (
    <div className="kd-enter">
      {/* Koyu bant: ayın sonucu */}
      <div className="bg-ink-900 text-white">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-6 pt-5 sm:px-6 lg:pt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[15px] font-medium text-ink-300">Genel bakış</h1>
              <p className="text-[13px] text-ink-400">{formatMonth(m)}{m === current ? " · ay devam ediyor" : ""}</p>
            </div>
            <form className="flex items-center gap-2">
              <label htmlFor="ay" className="sr-only">Dönem</label>
              <select id="ay" name="ay" defaultValue={m.slice(0, 7)} className="min-h-10 rounded-md border border-ink-700 bg-ink-850 px-3 text-[14px] text-white">
                {monthOptions.map((x) => <option key={x} value={x.slice(0, 7)}>{formatMonth(x)}</option>)}
              </select>
              <button className="min-h-10 rounded-md border border-ink-700 px-3 text-[14px] text-ink-200 hover:bg-ink-850">Göster</button>
            </form>
          </div>
          <div className="mt-6">
            <p className="text-[14px] text-ink-300">Faaliyet sonucu <span className="text-ink-400">— giderlerden sonra kalan</span></p>
            <p className={cx("num mt-1 text-[40px] font-semibold leading-none tracking-[-0.03em] sm:text-[52px]", pnl.operatingResult.isNegative() ? "text-[#ff8a80]" : "text-white")}>
              {formatTL(pnl.operatingResult)}
            </p>
            {opDelta && (
              <p className="mt-2 text-[13px] text-ink-300">
                Önceki aya göre <span className={cx("num font-medium", opDelta.isNegative() ? "text-[#ff8a80]" : "text-[#7ee2b0]")}>{opDelta.isNegative() ? "−" : "+"}{formatTL(opDelta.abs())}</span>
              </p>
            )}
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-ink-700/60 sm:grid-cols-4">
            {[
              { l: "Net satış", v: formatTL(pnl.netSalesKnownCost), h: "KDV hariç" },
              { l: "Brüt kâr", v: formatTL(pnl.grossProfit), h: pnl.grossMarginPct ? `marj %${pnl.grossMarginPct.toDecimalPlaces(1).toString().replace(".", ",")}` : "—" },
              { l: "İşletme giderleri", v: formatTL(pnl.expenses), h: "onaylı giderler" },
              { l: "Stok değeri", v: formatTL(pnl.stockValue), h: "ay sonu, maliyetle" },
            ].map((k) => (
              <div key={k.l} className="bg-ink-850 p-3.5">
                <dt className="text-[12.5px] text-ink-300">{k.l}</dt>
                <dd className="num mt-1 text-[19px] font-semibold tracking-[-0.02em] sm:text-[21px]">{k.v}</dd>
                <dd className="text-[12px] text-ink-400">{k.h}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <Page>
        {pnl.warnings.length > 0 && (
          <div className="mb-6 flex flex-col gap-2">
            {pnl.warnings.map((w) => <Callout key={w.key} tone="warn">{w.text}</Callout>)}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
          <Section title="Kâr tablosu" description={NOTE_MGMT}>
            <Panel padded={false}>
              <table className="w-full text-[14.5px]">
                <tbody>
                  {pnl.lines.filter((l) => !(l.hideIfZero && l.amount.isZero())).map((l) => (
                    <tr key={l.key} className={cx("border-b border-line last:border-b-0", l.emphasis && "bg-subtle")}>
                      <td className="px-4 py-3">
                        <span className={cx(l.emphasis ? "font-semibold" : "", "flex items-baseline gap-2")}>
                          <span aria-hidden className="num w-3 text-faint">{l.sign === "=" ? "=" : l.sign === "-" ? "−" : "+"}</span>
                          {l.label}
                        </span>
                        {l.hint && <span className="ml-5 block text-[12.5px] text-muted">{l.hint}</span>}
                      </td>
                      <td className={cx("num px-4 py-3 text-right", l.emphasis && "font-semibold", l.key === "operating_result" && (l.amount.isNegative() ? "text-neg" : "text-pos"))}>
                        {formatTL(l.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            {pnl.netSalesUnknownCost.gt(0) && (
              <p className="mt-2 text-[13px] text-muted">Maliyeti bilinmeyen satış: <Money value={pnl.netSalesUnknownCost} /> (kâra dahil edilmedi).</p>
            )}
          </Section>

          <Section title="Son 6 ay" description="Net satış (açık), brüt kâr (koyu) ve faaliyet sonucu (çizgi).">
            <Panel>
              {chart.some((c) => !dec(c.sales).isZero() || !dec(c.operating).isZero()) ? <MonthlyPnlChart data={chart} /> : <EmptyState title="Grafik için satış verisi yok">Satış raporu yükleyin.</EmptyState>}
            </Panel>
          </Section>
        </div>

        <div className="mt-2 grid gap-6 lg:grid-cols-2">
          <ProductList title="En çok kazandıranlar" rows={top} empty="Bu ay maliyeti bilinen satış yok." />
          <ProductList title="En az kazandıranlar" rows={bottom} empty="Bu ay maliyeti bilinen satış yok." negativeFirst />
        </div>

        <div className="mt-2 grid gap-6 lg:grid-cols-2">
          <Section title="Kritik stok" description={runRes.data ? "Son sipariş önerisine göre teslim süresi içinde bitecek ürünler." : "Stoğu biten ama satılan ürünler. Daha iyi tahmin için sipariş önerisi hesaplayın."}
            actions={<Link href="/siparis-onerileri" className="text-[13px] text-accent hover:underline">Sipariş önerileri</Link>}>
            <TableFrame>
              {critical.length === 0 ? <EmptyState title="Kritik stok yok" /> : (
                <Table><tbody>{critical.map((c) => (
                  <tr key={c.id}><Td><Link href={`/urunler/${c.id}`} className="text-accent hover:underline">{c.name}</Link></Td><Td align="right" className="num">{formatQty(c.stock, c.unit)}</Td><Td align="right" className="text-[13px] text-warn">{c.note}</Td></tr>
                ))}</tbody></Table>
              )}
            </TableFrame>
          </Section>
          <Section title="Uyarılar" actions={<Link href="/uyarilar" className="text-[13px] text-accent hover:underline">Tümü</Link>}>
            <TableFrame>
              {alerts.length === 0 ? <EmptyState title="Açık uyarı yok">Alış fiyatı artıp marjı düşen ürünler burada görünür.</EmptyState> : (
                <ul className="divide-y divide-line">{alerts.map((a) => <li key={a.id} className="px-4 py-3"><AlertLine alert={a as never} /></li>)}</ul>
              )}
            </TableFrame>
          </Section>
        </div>
      </Page>
    </div>
  );
}

function ProductList({ title, rows, empty, negativeFirst }: { title: string; rows: Array<{ product_id: string; name: string; base_unit: string; qty: string; net_sales: string; gross_profit: string; margin_pct: string | null }>; empty: string; negativeFirst?: boolean }) {
  return (
    <Section title={title} description="Bu ayın brüt kârına göre (KDV hariç satış − satılan malın maliyeti).">
      <TableFrame>
        {rows.length === 0 ? <EmptyState title={empty} /> : (
          <Table>
            <thead><tr><Th>Ürün</Th><Th align="right" className="hidden sm:table-cell">Satış</Th><Th align="right">Brüt kâr</Th><Th align="right">Marj</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.product_id} className="hover:bg-subtle">
                <Td><Link href={`/urunler/${r.product_id}`} className="text-accent hover:underline">{r.name}</Link><div className="num text-[12px] text-muted">{formatQty(r.qty, r.base_unit)}</div></Td>
                <Td align="right" className="hidden sm:table-cell"><Money value={r.net_sales} /></Td>
                <Td align="right"><Money value={r.gross_profit} tone={negativeFirst ? "auto" : "none"} /></Td>
                <Td align="right">{r.margin_pct ? <Pct value={r.margin_pct} className={dec(r.margin_pct).lt(0) ? "text-neg" : ""} /> : "—"}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </TableFrame>
    </Section>
  );
}

function Onboarding() {
  const steps = [
    { t: "Ürün / stok listesini yükleyin", d: "POS programından ürün listesini (barkod, ad, alış-satış fiyatı, KDV, stok) dışa aktarın. Açılış stoğu ve maliyetleri buradan oluşur." },
    { t: "Satış raporunu yükleyin", d: "Ürün bazlı satış raporunu (tercihen haftalık) yükleyin. Kâr ve sipariş önerileri buna dayanır." },
    { t: "Alış faturalarını ekleyin", d: "Tedarikçilerden gelen e-Fatura XML dosyaları maliyetleri günceller ve marj uyarılarını üretir." },
    { t: "Giderleri girin", d: "Kira, personel, SGK, elektrik… Faaliyet sonucu giderlerden sonra kalanı gösterir." },
  ];
  return (
    <Page width="narrow">
      <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Başlayalım</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">Henüz veri yok. Sayılar uydurulmaz: her rakam yüklediğiniz dosyalardan hesaplanır. Dört adımda hazır olur.</p>
      <ol className="mt-6 overflow-hidden rounded-md border border-line bg-surface">
        {steps.map((s, i) => (
          <li key={s.t} className="flex gap-4 border-b border-line p-4 last:border-b-0">
            <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-900 text-[13px] font-semibold text-white">{i + 1}</span>
            <div><p className="font-medium">{s.t}</p><p className="mt-0.5 text-[14px] text-muted">{s.d}</p></div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex gap-2">
        <LinkButton href="/veri" variant="primary">Dosya yükle</LinkButton>
        <Link href="/giderler" className={buttonClass("secondary")}>Gider gir</Link>
      </div>
    </Page>
  );
}

