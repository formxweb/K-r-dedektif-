import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { friendlyError, must } from "@/lib/errors";
import { dec } from "@/lib/domain/decimal";
import { formatDate, formatQty } from "@/lib/domain/format";
import { Badge, Callout, Money, Page, PageHeader, Panel, Pct, Section, Table, TableFrame, Td, Th, buttonClass } from "@/components/ui";
import { EffectsSummary } from "@/components/effects";
import { cancelInvoiceJob, ignoreItem } from "@/server/invoices";
import { MatchForm, NewProductForm } from "./match";
import { PostForm } from "./post-form";

export const metadata: Metadata = { title: "Fatura" };

interface Item {
  id: string; line_no: number; raw_name: string; raw_code: string | null; raw_barcode: string | null; unit_code: string; unit_name: string | null; unit_kind: string;
  qty: string; unit_price: string; discount_amount: string; line_net: string; vat_rate: string; vat_amount: string;
  product_id: string | null; unit_factor: string | null; base_qty: string | null; unit_cost_base: string | null;
  match_method: string | null; match_status: string; suggested_product_id: string | null; suggestion_score: string | null;
  product: { id: string; name: string; barcode: string | null; code: string | null; base_unit: string } | null;
  suggested: { id: string; name: string; barcode: string | null; code: string | null; base_unit: string } | null;
}

const METHOD: Record<string, string> = { barcode: "barkod", unit_barcode: "koli barkodu", alias: "kayıtlı eşleşme", manual: "elle" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ islendi?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("purchase_invoices")
    .select("id, import_job_id, invoice_no, ettn, invoice_date, invoice_type, status, total_mismatch, doc_total_excl_vat::text, doc_total_vat::text, doc_total_incl_vat::text, calc_total_excl_vat::text, calc_total_vat::text, calc_total_incl_vat::text, suppliers(id, name, tax_number)")
    .eq("id", id).eq("organization_id", org.id).maybeSingle();
  if (!inv) notFound();
  const items = must(await supabase
    .from("purchase_items")
    .select("id, line_no, raw_name, raw_code, raw_barcode, unit_code, unit_name, unit_kind, qty::text, unit_price::text, discount_amount::text, line_net::text, vat_rate::text, vat_amount::text, product_id, unit_factor::text, base_qty::text, unit_cost_base::text, match_method, match_status, suggested_product_id, suggestion_score::text, product:products!purchase_items_product_id_fkey(id, name, barcode, code, base_unit), suggested:products!purchase_items_suggested_product_id_fkey(id, name, barcode, code, base_unit)")
    .eq("invoice_id", id).order("line_no")) as unknown as Item[];
  const job = (await supabase.from("import_jobs").select("id, status, params, file_name").eq("id", inv.import_job_id).single()).data;
  const supplier = inv.suppliers as unknown as { id: string; name: string; tax_number: string | null } | null;
  const draft = inv.status === "draft";
  const open = items.filter((i) => i.match_status === "unmatched" || i.match_status === "suggested" || (i.match_status === "matched" && !i.unit_factor));
  const warnings = ((job?.params as Record<string, unknown> | null)?.warnings as string[] | undefined) ?? [];

  let preview: Record<string, unknown> | null = null;
  let previewError: string | null = null;
  if (draft && open.length === 0 && job?.status === "staged") {
    const r = await supabase.rpc("preview_commit", { p_job: inv.import_job_id });
    if (r.error) previewError = friendlyError(r.error);
    else preview = r.data as Record<string, unknown>;
  }
  const alerts = inv.status === "posted"
    ? must(await supabase.from("alerts").select("id, alert_type, payload, product_id, status, products(name)").eq("source_id", id).eq("source_type", "purchase_invoice").order("created_at"))
    : [];

  const statusBadge = { draft: <Badge tone="warn">Eşleştirme bekliyor</Badge>, posted: <Badge tone="pos">İşlendi</Badge>, reversed: <Badge>Geri alındı</Badge>, cancelled: <Badge>İptal</Badge> }[inv.status as string];

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: "/faturalar", label: "Alış faturaları" }]}
        title={`${supplier?.name ?? "Tedarikçi"} · ${inv.invoice_no}`}
        meta={<>{statusBadge}<span>{formatDate(inv.invoice_date)}</span>{supplier?.tax_number && <span className="num">VKN {supplier.tax_number}</span>}{inv.invoice_type && <span>{inv.invoice_type}</span>}</>}
        actions={draft && job?.status === "staged" ? (
          <form action={cancelInvoiceJob}><input type="hidden" name="job_id" value={inv.import_job_id} /><button className={buttonClass("secondary")}>Faturayı iptal et</button></form>
        ) : inv.status === "posted" ? <Link className={buttonClass("secondary")} href={`/veri/${inv.import_job_id}`}>Aktarımı aç / geri al</Link> : undefined}
      />

      {sp.islendi && <div className="mb-5"><Callout tone="pos" title="Fatura işlendi">Stok ve ortalama maliyetler güncellendi.{alerts.some((a) => a.alert_type === "margin_drop") ? " Marjı düşen ürünler aşağıda." : ""}</Callout></div>}
      {inv.total_mismatch && (
        <div className="mb-4"><Callout tone="neg" title="Fatura toplamı satırlarla tutmuyor">
          Belgedeki genel toplam <Money value={inv.doc_total_incl_vat} />, satırlardan hesaplanan <Money value={inv.calc_total_incl_vat} />. Fark 0,05 TL’den büyük; tedarikçiyle kontrol edin. Maliyet satırlardan hesaplanır.
        </Callout></div>
      )}
      {warnings.length > 0 && <div className="mb-4 flex flex-col gap-2">{warnings.map((w) => <Callout key={w} tone="info">{w}</Callout>)}</div>}

      <dl className="mb-6 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
        {[["KDV hariç", inv.calc_total_excl_vat, inv.doc_total_excl_vat], ["KDV", inv.calc_total_vat, inv.doc_total_vat], ["Genel toplam", inv.calc_total_incl_vat, inv.doc_total_incl_vat]].map(([l, c, d]) => (
          <div key={l} className="bg-surface p-3">
            <dt className="text-[12.5px] text-muted">{l}</dt>
            <dd className="mt-0.5 text-[16px] font-semibold"><Money value={c} /></dd>
            {d && <dd className="text-[12px] text-faint">Belgede: <Money value={d} /></dd>}
          </div>
        ))}
      </dl>

      {draft && open.length > 0 && (
        <div className="mb-4"><Callout tone="warn" title={`${open.length} satır eşleştirme bekliyor`}>
          Barkodla eşleşmeyen satırlar için ürünü seçin. Onayladığınız eşleşme bu tedarikçi için kaydedilir ve bir daha sorulmaz. Stok dışı satırları (nakliye, depozito) yoksayın.
        </Callout></div>
      )}

      <Section title="Satırlar">
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const unitLabel = it.unit_name || it.unit_code || "birim";
            const needsWork = draft && (it.match_status === "unmatched" || it.match_status === "suggested" || (it.match_status === "matched" && !it.unit_factor));
            return (
              <Panel key={it.id} className={needsWork ? "border-warn/40" : ""}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{it.line_no}. {it.raw_name}</p>
                    <p className="num text-[12.5px] text-muted">{[it.raw_barcode && `Barkod ${it.raw_barcode}`, it.raw_code && `Kod ${it.raw_code}`].filter(Boolean).join(" · ") || "Barkod yok"}</p>
                  </div>
                  <div className="num text-left text-[14px] sm:text-right">
                    <div>{formatQty(it.qty)} {unitLabel} × <Money value={it.unit_price} /></div>
                    <div className="text-[12.5px] text-muted">Net <Money value={it.line_net} />{!dec(it.discount_amount).isZero() && <> · iskonto <Money value={it.discount_amount} /></>} · KDV <Pct value={it.vat_rate} /></div>
                  </div>
                </div>
                <div className="mt-3 border-t border-line pt-3">
                  {it.match_status === "ignored" ? (
                    <div className="flex items-center justify-between gap-2 text-[14px] text-muted">
                      <span>Stok dışı satır — maliyete eklenmez.</span>
                      {draft && <form action={ignoreItem}><input type="hidden" name="item_id" value={it.id} /><input type="hidden" name="invoice_id" value={id} /><input type="hidden" name="ignored" value="0" /><button className="text-accent hover:underline">Geri al</button></form>}
                    </div>
                  ) : it.match_status === "matched" && it.unit_factor && !needsWork ? (
                    <div className="flex flex-col gap-1 text-[14px] sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        <Link href={`/urunler/${it.product_id}`} className="font-medium text-accent hover:underline">{it.product?.name}</Link>
                        {it.match_method && <span className="ml-2 text-[12.5px] text-muted">({METHOD[it.match_method]})</span>}
                      </span>
                      <span className="num text-muted">
                        {dec(it.unit_factor).eq(1) ? "" : `1 ${unitLabel} = ${formatQty(it.unit_factor)} ${it.product?.base_unit} · `}
                        {formatQty(it.base_qty)} {it.product?.base_unit} · birim maliyet <Money value={it.unit_cost_base} decimals={4} />
                      </span>
                    </div>
                  ) : draft ? (
                    <div className="flex flex-col gap-2">
                      {it.match_status === "suggested" && it.suggested && (
                        <p className="text-[13px] text-muted">Öneri: <span className="font-medium text-text">{it.suggested.name}</span> (benzerlik %{Math.round(Number(it.suggestion_score ?? 0) * 100)}). Doğruysa onaylayın.</p>
                      )}
                      {it.match_status === "matched" && !it.unit_factor && (
                        <p className="text-[13px] text-warn">Ürün bulundu ({it.product?.name}) ama “{unitLabel}” biriminin {it.product?.base_unit} karşılığı tanımlı değil.</p>
                      )}
                      <MatchForm invoiceId={id} itemId={it.id} unitLabel={unitLabel} needsFactor={it.unit_kind === "package" || it.unit_kind === "unknown" || (it.match_status === "matched" && !it.unit_factor)}
                        suggestion={it.match_status === "suggested" ? it.suggested : null} current={it.match_status === "matched" ? it.product : null} />
                      <div className="flex flex-wrap items-center gap-4">
                        <NewProductForm invoiceId={id} itemId={it.id} name={it.raw_name} barcode={it.raw_barcode} unitLabel={unitLabel} unitIsPackage={it.unit_kind === "package"} />
                        <form action={ignoreItem}><input type="hidden" name="item_id" value={it.id} /><input type="hidden" name="invoice_id" value={id} /><input type="hidden" name="ignored" value="1" /><button className="text-[13px] text-muted hover:text-text hover:underline">Stok dışı (yoksay)</button></form>
                      </div>
                    </div>
                  ) : (
                    <span className="text-[14px] text-muted">Eşleşmedi</span>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      </Section>

      {draft && open.length === 0 && job?.status === "staged" && (
        <Section title="Faturayı işle" description="İşlenince stok artar, hareketli ortalama maliyet güncellenir ve alış fiyatı artan ürünler için marj uyarısı oluşur.">
          {previewError ? <Callout tone="neg" title="Fatura şu haliyle işlenemez">{previewError}</Callout> : (
            <div className="flex flex-col gap-3">
              <EffectsSummary result={preview} />
              <PostForm invoiceId={id} jobId={inv.import_job_id} version={String(preview?.ledger_version ?? "")} />
            </div>
          )}
        </Section>
      )}

      {alerts.length > 0 && (
        <Section title="Bu faturadan oluşan uyarılar">
          <TableFrame>
            <Table>
              <thead><tr><Th>Ürün</Th><Th align="right">Alış</Th><Th align="right">Marj</Th><Th align="right">Önerilen fiyat</Th></tr></thead>
              <tbody>
                {alerts.filter((a) => a.alert_type === "margin_drop").map((a) => {
                  const p = a.payload as Record<string, string>;
                  return (
                    <tr key={a.id}>
                      <Td><Link href={`/urunler/${a.product_id}`} className="text-accent hover:underline">{(a.products as unknown as { name: string } | null)?.name}</Link></Td>
                      <Td align="right"><Money value={p.prev_cost} /> → <Money value={p.new_cost} /> <span className="text-neg">(<Pct value={p.cost_increase_pct} signed />)</span></Td>
                      <Td align="right"><Pct value={p.old_margin_pct} /> → <span className="text-neg"><Pct value={p.new_margin_pct} /></span></Td>
                      <Td align="right" className="font-semibold"><Money value={p.suggested_price_gross} /></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        </Section>
      )}
    </Page>
  );
}
