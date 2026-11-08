import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { fetchAll } from "@/lib/data/common";
import { addDays, addMonths, istToday, monthStart } from "@/lib/domain/dates";
import { formatDate, formatMonth, formatQty } from "@/lib/domain/format";
import { Callout, EmptyState, Page, PageHeader, Panel, Section, Table, TableFrame, Td, Th } from "@/components/ui";
import { deleteMarker } from "@/server/settings";
import { BulkVatForm, ClosePeriodForm, MarkerForm, OrgForm, ReopenPeriodForm, SupplierForm } from "./forms";

export const metadata: Metadata = { title: "Ayarlar" };

const NAV = [
  ["isletme", "İşletme"], ["tedarikciler", "Tedarikçiler"], ["kdv", "KDV oranları"], ["birimler", "Birimler"], ["donemler", "Dönem işaretleri"], ["kapanis", "Dönem kapatma"],
] as const;

export default async function SettingsPage() {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const today = istToday();
  const [suppliers, rates, units, markers, categories] = await Promise.all([
    supabase.from("suppliers").select("id, name, tax_number, lead_time_days, order_interval_days, min_order_amount::text, phone").eq("organization_id", org.id).eq("is_active", true).order("name"),
    fetchAll<{ rate: string }>((a, b) => supabase.from("tax_rates").select("rate::text").eq("organization_id", org.id).is("valid_to", null).order("id").range(a, b)),
    supabase.from("product_units").select("id, name, factor::text, barcode, product_id, products(name, base_unit)").eq("organization_id", org.id).order("name").limit(500),
    supabase.from("period_markers").select("id, name, start_date, end_date, multiplier::text, categories(name)").eq("organization_id", org.id).order("start_date", { ascending: false }),
    supabase.from("categories").select("id, name").eq("organization_id", org.id).order("name"),
  ]);
  const rateCounts = new Map<string, number>();
  for (const r of rates) {
    const k = r.rate.replace(/\.?0+$/, "");
    rateCounts.set(k, (rateCounts.get(k) ?? 0) + 1);
  }
  const lastFullMonth = addMonths(monthStart(today), -1);
  const nextToClose = org.closed_through ? addDays(org.closed_through, 1) : null;
  const closable = (nextToClose ?? lastFullMonth) <= lastFullMonth ? (nextToClose ?? lastFullMonth) : null;
  const lastClosed = org.closed_through ? monthStart(org.closed_through) : null;
  const isAdmin = org.role !== "member";

  return (
    <Page>
      <PageHeader title="Ayarlar" description="Ürünün nasıl hesap yaptığını belirleyen işletme ayarları." />
      <div className="lg:grid lg:grid-cols-[180px_1fr] lg:gap-10">
        <nav aria-label="Ayar bölümleri" className="mb-6 lg:sticky lg:top-8 lg:mb-0 lg:self-start">
          <ul className="flex gap-4 overflow-x-auto whitespace-nowrap text-[14px] lg:flex-col lg:gap-1">
            {NAV.map(([id, l]) => <li key={id}><a href={`#${id}`} className="inline-flex min-h-9 items-center text-muted hover:text-text lg:px-2">{l}</a></li>)}
          </ul>
        </nav>
        <div className="min-w-0">
          <Section id="isletme" title="İşletme">
            <Panel><OrgForm org={{ name: org.name, threshold: org.margin_alert_threshold_pts.replace(/\.?0+$/, ""), dead: org.dead_stock_days, step: org.price_rounding_step.replace(/0+$/, "").replace(/\.$/, "") }} /></Panel>
            {!isAdmin && <p className="mt-2 text-[13px] text-muted">Bu ayarları sadece işletme sahibi veya yönetici değiştirebilir.</p>}
          </Section>

          <Section id="tedarikciler" title="Tedarikçiler" description="Teslim süresi ve sipariş aralığı sipariş önerisinde kullanılır. Faturadan gelen tedarikçiler otomatik eklenir.">
            <div className="flex flex-col gap-2">
              {must(suppliers).map((s) => <details key={s.id} className="rounded-md border border-line bg-surface">
                <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 text-[14px]"><span className="font-medium">{s.name}</span><span className="text-muted">teslim {s.lead_time_days} gün · her {s.order_interval_days} günde bir</span></summary>
                <div className="border-t border-line p-4"><SupplierForm s={s} /></div>
              </details>)}
              <Panel><p className="mb-3 text-[14px] font-medium">Yeni tedarikçi</p><SupplierForm /></Panel>
            </div>
          </Section>

          <Section id="kdv" title="KDV oranları" description="Oranlar ürün bazında ve tarih aralıklı tutulur. Değişiklik yeni aktarımları etkiler; geçmiş kayıtlar değişmez.">
            <TableFrame>
              {rateCounts.size === 0 ? <EmptyState title="Henüz KDV oranı yok">Ürün listesi yüklendiğinde gelir.</EmptyState> : (
                <Table><thead><tr><Th>Güncel oran</Th><Th align="right">Ürün sayısı</Th></tr></thead>
                  <tbody>{[...rateCounts.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([r, n]) => <tr key={r}><Td>%{r}</Td><Td align="right" className="num">{n}</Td></tr>)}</tbody></Table>
              )}
            </TableFrame>
            {rateCounts.size > 0 && <div className="mt-3"><Panel><p className="mb-3 text-[14px] font-medium">Toplu oran değişikliği</p><BulkVatForm rates={[...rateCounts.keys()]} today={today} /></Panel></div>}
          </Section>

          <Section id="birimler" title="Birimler" description="Koli/paket gibi alış birimlerinin temel birim karşılıkları. Ürün ekranından eklenir veya fatura eşleştirirken kaydedilir.">
            <TableFrame>
              {must(units).length === 0 ? <EmptyState title="Tanımlı alış birimi yok" /> : (
                <Table><thead><tr><Th>Ürün</Th><Th>Birim</Th><Th align="right">Karşılığı</Th></tr></thead>
                  <tbody>{must(units).map((u) => {
                    const p = u.products as unknown as { name: string; base_unit: string };
                    return <tr key={u.id}><Td><Link href={`/urunler/${u.product_id}?sekme=birimler`} className="text-accent hover:underline">{p?.name}</Link></Td><Td>1 {u.name}</Td><Td align="right" className="num">{formatQty(u.factor, p?.base_unit)}</Td></tr>;
                  })}</tbody></Table>
              )}
            </TableFrame>
          </Section>

          <Section id="donemler" title="Dönem işaretleri" description="Ramazan, bayram, okul açılışı gibi dönemlerde satış çarpanı. 12 aydan az veriyle mevsimsellik öğrenilmez; bunun yerine buradan girilir.">
            <TableFrame>
              {must(markers).length === 0 ? <EmptyState title="Dönem işareti yok" /> : (
                <Table><thead><tr><Th>Dönem</Th><Th>Tarih</Th><Th align="right">Çarpan</Th><Th align="right"> </Th></tr></thead>
                  <tbody>{must(markers).map((m) => (
                    <tr key={m.id}>
                      <Td>{m.name}<div className="text-[12.5px] text-muted">{(m.categories as unknown as { name: string } | null)?.name ?? "Tüm ürünler"}</div></Td>
                      <Td className="num text-muted">{formatDate(m.start_date)} – {formatDate(m.end_date)}</Td>
                      <Td align="right" className="num">×{m.multiplier.replace(/\.?0+$/, "").replace(".", ",")}</Td>
                      <Td align="right"><form action={deleteMarker}><input type="hidden" name="id" value={m.id} /><button className="text-[13px] text-neg hover:underline">Sil</button></form></Td>
                    </tr>
                  ))}</tbody></Table>
              )}
            </TableFrame>
            <div className="mt-3"><Panel><MarkerForm categories={must(categories)} /></Panel></div>
          </Section>

          <Section id="kapanis" title="Dönem kapatma" description="Ayı kapatınca o ayın kârı sabitlenir. Sonradan gelen faturalar geçmiş kârı sessizce değiştiremez.">
            <Panel>
              <p className="text-[14px]">{org.closed_through ? <>Kapalı dönem: <strong>{formatDate(org.closed_through)}</strong> dahil öncesi.</> : "Henüz kapatılmış ay yok."}</p>
              {isAdmin ? (
                <div className="mt-4 flex flex-col gap-4">
                  {closable ? <ClosePeriodForm month={closable} label={formatMonth(closable)} /> : <p className="text-[13px] text-muted">Kapatılabilecek bitmiş ay yok.</p>}
                </div>
              ) : <p className="mt-2 text-[13px] text-muted">Dönem kapatma yönetici yetkisi gerektirir.</p>}
            </Panel>
            {isAdmin && lastClosed && (
              <div className="mt-6 rounded-md border border-neg/30 bg-surface p-4">
                <p className="text-[14px] font-semibold text-neg">Tehlikeli bölge</p>
                <div className="mt-2"><Callout tone="neg">Son kapatılan ayı yeniden açmak o ayın kârını değiştirebilir. Sadece geçmiş tarihli bir hatayı düzeltmeniz gerekiyorsa kullanın.</Callout></div>
                <div className="mt-3"><ReopenPeriodForm month={lastClosed} label={formatMonth(lastClosed)} /></div>
              </div>
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}
