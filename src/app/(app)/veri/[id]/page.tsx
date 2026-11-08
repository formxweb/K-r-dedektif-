import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { friendlyError, must } from "@/lib/errors";
import { FIELDS, KIND_LABEL, suggestMapping, type ImportKind } from "@/lib/import/fields";
import { detectDecimalSeparator } from "@/lib/import/number";
import { getCommitPreview, loadJobTable, type JobRow } from "@/lib/data/imports";
import { istToday } from "@/lib/domain/dates";
import { formatDate, formatDateShort, formatMonth, formatQty } from "@/lib/domain/format";
import { Badge, Callout, EmptyState, Money, Page, PageHeader, Panel, Section, Table, TableFrame, Td, Th, buttonClass } from "@/components/ui";
import { EffectsSummary } from "@/components/effects";
import { cancelJob, setCountApprovals, skipUnmatched } from "@/server/imports";
import { MappingForm } from "./mapping-form";
import { CommitForm, MissingProductsForm, RevertForm } from "./forms";

export const metadata: Metadata = { title: "Aktarım" };

type Row = { id: string; row_number: number; status: string; messages: string[]; parsed: Record<string, unknown> | null; product_id: string | null };

const ROW_STATUS: Record<string, { label: string; tone: "neutral" | "pos" | "warn" | "neg" | "info" }> = {
  ok: { label: "Tamam", tone: "pos" },
  warning: { label: "Uyarı", tone: "warn" },
  error: { label: "Hata", tone: "neg" },
  duplicate: { label: "Tekrar", tone: "neg" },
  needs_review: { label: "Ürün eşleşmedi", tone: "warn" },
  skipped: { label: "Atlandı", tone: "neutral" },
};

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ kaydedildi?: string; geri_alindi?: string; geri_al?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data: job } = await supabase.from("import_jobs").select("*").eq("id", id).eq("organization_id", org.id).maybeSingle();
  if (!job) notFound();

  const kind = job.kind as ImportKind | "purchase_invoice_xml";
  const isTable = kind !== "purchase_invoice_xml";
  const statuses = ["ok", "warning", "error", "duplicate", "needs_review", "skipped"] as const;
  const counts = Object.fromEntries(
    await Promise.all(statuses.map(async (s) => [s, (await supabase.from("import_rows").select("id", { count: "exact", head: true }).eq("job_id", id).eq("status", s)).count ?? 0] as const)),
  ) as Record<(typeof statuses)[number], number>;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const problems = must(await supabase.from("import_rows").select("id, row_number, status, messages, parsed, product_id").eq("job_id", id).in("status", ["error", "duplicate", "needs_review", "warning"]).order("row_number").limit(300)) as Row[];
  const diffs = kind === "product_list"
    ? (must(await supabase.from("import_rows").select("id, row_number, status, messages, parsed, product_id").eq("job_id", id).not("parsed->count_diff", "is", null).order("row_number").limit(2000)) as Row[])
    : [];
  const invoices = !isTable || kind === "purchase_invoice_table"
    ? must(await supabase.from("purchase_invoices").select("id, invoice_no, invoice_date, status, calc_total_incl_vat::text, suppliers(name)").eq("import_job_id", id))
    : [];

  const p = (job.params ?? {}) as Record<string, unknown>;
  const spansMonths = kind === "sales_summary" && typeof p.period_start === "string" && typeof p.period_end === "string"
    && p.period_start.slice(0, 7) !== p.period_end.slice(0, 7);
  const staged = job.status === "staged";
  const prepared = staged && total > 0;

  // Önizleme / geri alma etkisi (veritabanında aynı kodla çalışıp geri sarılır)
  let preview: Record<string, unknown> | null = null;
  let previewError: string | null = null;
  if (prepared && isTable && kind !== "purchase_invoice_table") {
    // Saklanan önizleme defter sürümü değişmediyse tekrar hesaplanmaz.
    const pv = await getCommitPreview(supabase, job as JobRow, org.ledger_version);
    preview = pv.result;
    previewError = pv.error;
  }
  let revertPreview: Record<string, unknown> | null = null;
  let revertError: string | null = null;
  const wantsRevert = sp.geri_al === "1";
  if (job.status === "committed" && wantsRevert) {
    const r = await supabase.rpc("preview_revert", { p_job: id });
    if (r.error) revertError = friendlyError(r.error);
    else revertPreview = r.data as Record<string, unknown>;
  }

  // Eşleştirme formu için dosya
  let mappingProps: Parameters<typeof MappingForm>[0] | null = null;
  let fileError: string | null = null;
  if (staged && isTable) {
    try {
      const { sheet } = await loadJobTable(id);
      const headerRow = Number(p.header_row ?? 0);
      const headers = (sheet.rows[headerRow] ?? []).map((c, i) => (c === null || c === "" ? `Sütun ${i + 1}` : String(c).trim()));
      const sampleValues = sheet.rows.slice(headerRow + 1, headerRow + 200).flat().filter((c) => typeof c === "string");
      const profile = job.profile_id ? (await supabase.from("import_profiles").select("name, column_map, options, header_row").eq("id", job.profile_id).maybeSingle()).data : null;
      const suppliers = kind === "purchase_invoice_table" ? must(await supabase.from("suppliers").select("id, name").eq("organization_id", org.id).eq("is_active", true).order("name")) : [];
      mappingProps = {
        jobId: id,
        kind: kind as ImportKind,
        fields: FIELDS[kind as ImportKind],
        rows: sheet.rows.slice(0, 40),
        headerRow,
        mapping: (p.mapping as Record<string, string>) ?? (profile?.column_map as Record<string, string>) ?? {},
        suggested: suggestMapping(kind as ImportKind, headers),
        options: (p.options as never) ?? (profile?.options as never) ?? {},
        detectedSeparator: detectDecimalSeparator(sampleValues),
        params: Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        suppliers,
        profileName: profile?.name ?? null,
        today: istToday(),
      };
    } catch (e) {
      fileError = e instanceof Error ? e.message : "Dosya okunamadı.";
    }
  }

  const statusBadge = { staged: <Badge tone="warn">İşlenmeyi bekliyor</Badge>, committed: <Badge tone="pos">İşlendi</Badge>, reverted: <Badge>Geri alındı</Badge>, cancelled: <Badge>İptal edildi</Badge> }[job.status as string];
  const result = (job.result ?? null) as Record<string, unknown> | null;

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: "/veri", label: "Veri yükleme" }]}
        title={job.file_name}
        meta={<>{statusBadge}<span>{KIND_LABEL[kind]}</span><span>Yüklenme: {formatDateShort(job.created_at)}</span>{job.committed_at && <span>İşlenme: {formatDateShort(job.committed_at)}</span>}</>}
        actions={staged ? (
          <form action={cancelJob}><input type="hidden" name="job_id" value={id} /><button className={buttonClass("secondary")}>Aktarımı iptal et</button></form>
        ) : undefined}
      />

      {sp.kaydedildi && <div className="mb-5"><Callout tone="pos" title="Aktarım kaydedildi">Stok ve maliyetler güncellendi. Genel bakış ve ürün ekranları yeni verileri gösteriyor.</Callout></div>}
      {sp.geri_alindi && <div className="mb-5"><Callout tone="pos" title="Aktarım geri alındı">İlgili kayıtlar iptal edildi, stok ve maliyet zinciri yeniden hesaplandı.</Callout></div>}
      {fileError && <div className="mb-5"><Callout tone="neg" title="Dosya okunamadı">{fileError}</Callout></div>}

      {/* Fatura aktarımları: faturaya yönlendir */}
      {invoices.length > 0 && (
        <Section title="Bu dosyadaki faturalar">
          <TableFrame>
            <Table>
              <thead><tr><Th>Fatura</Th><Th className="hidden sm:table-cell">Tedarikçi</Th><Th align="right">Toplam</Th><Th>Durum</Th></tr></thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-subtle">
                    <Td><Link href={`/faturalar/${inv.id}`} className="font-medium text-accent hover:underline">{inv.invoice_no}</Link><div className="text-[12.5px] text-muted">{formatDate(inv.invoice_date)}</div></Td>
                    <Td className="hidden sm:table-cell">{(inv.suppliers as unknown as { name: string } | null)?.name}</Td>
                    <Td align="right"><Money value={inv.calc_total_incl_vat} /></Td>
                    <Td><Badge tone={inv.status === "posted" ? "pos" : inv.status === "draft" ? "warn" : "neutral"}>{{ draft: "Eşleştirme bekliyor", posted: "İşlendi", cancelled: "İptal", reversed: "Geri alındı" }[inv.status as string]}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        </Section>
      )}

      {/* Adım 1: eşleştirme */}
      {mappingProps && (
        prepared ? (
          <details className="mb-6 rounded-md border border-line bg-surface">
            <summary className="flex min-h-12 cursor-pointer items-center px-4 text-[14px] font-medium">Sütun eşleştirmesini değiştir</summary>
            <div className="border-t border-line p-4"><MappingForm {...mappingProps} /></div>
          </details>
        ) : (
          <Section title="1. Sütunları eşleştirin" description="Dosyanın biçimini bir kez tanıtın; profil kaydedilirse aynı başlıklı dosyalarda otomatik uygulanır.">
            <Panel><MappingForm {...mappingProps} /></Panel>
          </Section>
        )
      )}

      {/* Adım 2: önizleme */}
      {total > 0 && isTable && kind !== "purchase_invoice_table" && (
        <Section title={staged ? "2. Önizleme" : "Satırlar"} description={staged ? "Sadece “Tamam” ve “Uyarı” satırları kaydedilir. Diğerleri işlenmez." : undefined}>
          <div className="mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-6">
            {statuses.map((s) => (
              <div key={s} className="bg-surface p-3">
                <div className="text-[12.5px] text-muted">{ROW_STATUS[s]!.label}</div>
                <div className={`num text-[20px] font-semibold ${counts[s] && (s === "error" || s === "duplicate") ? "text-neg" : ""}`}>{counts[s]}</div>
              </div>
            ))}
          </div>

          {staged && counts.needs_review > 0 && (
            <div className="mb-4 flex flex-col gap-3">
              <Callout tone="warn" title={`${counts.needs_review} satırdaki ürün kayıtlı ürünlerle eşleşmedi`}>
                Bu satırlar işlenmezse satış toplamı eksik kalır. Ürün listesini önce yüklemek en doğrusudur. Ürünler listede yoksa yeni ürün olarak ekleyebilir veya atlayabilirsiniz.
              </Callout>
              <Panel>
                <MissingProductsForm jobId={id} />
                <form action={skipUnmatched} className="mt-3">
                  <input type="hidden" name="job_id" value={id} />
                  <button className="text-[14px] text-accent hover:underline">Eşleşmeyen satırları atla</button>
                </form>
              </Panel>
            </div>
          )}

          {diffs.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1 text-[15px] font-semibold">Sayım farkı önerileri</h3>
              <p className="mb-3 text-[13px] text-muted">POS’taki stok, sistemin hareketlerden hesapladığı stoktan farklı. Onayladığınız farklar “sayım farkı” olarak kâr tablosuna yazılır.</p>
              <form action={setCountApprovals}>
                <input type="hidden" name="job_id" value={id} />
                <TableFrame footer={staged ? <button className={buttonClass("secondary")}>Seçimi kaydet</button> : undefined}>
                  <Table>
                    <thead><tr><Th>{staged ? "Onay" : ""}</Th><Th>Ürün</Th><Th align="right">Hesaplanan</Th><Th align="right">POS listesi</Th><Th align="right">Fark</Th></tr></thead>
                    <tbody>
                      {diffs.map((r) => (
                        <tr key={r.id}>
                          <Td>{staged ? <input type="checkbox" name="approve" value={r.id} defaultChecked={Boolean(r.parsed?.apply_count)} aria-label={`${String(r.parsed?.name)} farkını onayla`} className="h-4 w-4" /> : r.parsed?.apply_count ? "✓" : "—"}</Td>
                          <Td>{String(r.parsed?.name ?? "")}</Td>
                          <Td align="right" className="num">{formatQty(String(r.parsed?.calc_stock ?? ""))}</Td>
                          <Td align="right" className="num">{formatQty(String(r.parsed?.stock_qty ?? ""))}</Td>
                          <Td align="right" className={`num ${String(r.parsed?.count_diff).startsWith("-") ? "text-neg" : "text-pos"}`}>{formatQty(String(r.parsed?.count_diff ?? ""))}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableFrame>
              </form>
            </div>
          )}

          {problems.length > 0 && (
            <TableFrame>
              <Table>
                <thead><tr><Th>Satır</Th><Th>Durum</Th><Th>Açıklama</Th></tr></thead>
                <tbody>
                  {problems.map((r) => (
                    <tr key={r.id}>
                      <Td className="num text-muted">{r.row_number}</Td>
                      <Td><Badge tone={ROW_STATUS[r.status]?.tone}>{ROW_STATUS[r.status]?.label}</Badge></Td>
                      <Td className="text-[13.5px]">
                        {r.parsed?.name ? <span className="font-medium">{String(r.parsed.name)} · </span> : null}
                        {r.messages.join(" · ")}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          )}
          {problems.length === 0 && counts.ok > 0 && <Callout tone="pos" title="Tüm satırlar sorunsuz">{counts.ok} satır kaydedilmeye hazır.</Callout>}
        </Section>
      )}

      {/* Adım 3: etki ve kayıt */}
      {prepared && kind !== "purchase_invoice_table" && isTable && (
        <Section title="3. Kaydet" description="Kaydetmeden önce bu işlemin geçmiş kârlara etkisini görün.">
          {previewError ? (
            <Callout tone="neg" title="Bu aktarım şu haliyle kaydedilemez">{previewError}</Callout>
          ) : (
            <div className="flex flex-col gap-4">
              {spansMonths && (
                <Callout tone="warn" title="Bu rapor iki aya yayılıyor">
                  {formatDate(String(p.period_start))} – {formatDate(String(p.period_end))} arasındaki satışların tamamı bitiş ayına ({formatMonth(String(p.period_end))}) yazılacak; {formatMonth(String(p.period_start))} kârına girmeyecek. Ay bazında doğru kâr için raporu ay sonunda bölerek (ör. 28–31 Ekim ve 1–3 Kasım) iki ayrı dosya olarak alın.
                </Callout>
              )}
              <PreviewFacts kind={kind} preview={preview} />
              <EffectsSummary result={preview} />
              <CommitForm jobId={id} version={String(preview?.ledger_version ?? "")} okCount={counts.ok + counts.warning} skipped={counts.error + counts.duplicate + counts.needs_review + counts.skipped} />
            </div>
          )}
        </Section>
      )}

      {/* İşlenmiş aktarım: sonuç + geri alma */}
      {job.status === "committed" && (
        <>
          <Section title="Sonuç">
            <div className="flex flex-col gap-3">
              <PreviewFacts kind={kind} preview={result} />
              <EffectsSummary result={result} verb="değişti" />
            </div>
          </Section>
          <Section id="geri-al" title="Aktarımı geri al" description="Bu aktarımın oluşturduğu tüm kayıtlar tek seferde iptal edilir; stok ve maliyet zinciri yeniden hesaplanır. Silinmez, iz kalır.">
            {!wantsRevert ? (
              <Panel>
                <p className="mb-3 text-[14px] text-muted">Geri almadan önce, bu işlemin geçmiş kârlara etkisini görün. Büyük aktarımlarda hesaplama birkaç saniye sürebilir.</p>
                <Link href={`/veri/${id}?geri_al=1#geri-al`} className={buttonClass("secondary")}>Geri almanın etkisini göster</Link>
              </Panel>
            ) : revertError ? (
              <Callout tone="neg" title="Bu aktarım şu an geri alınamaz">{revertError}</Callout>
            ) : (
              <Panel>
                <div className="mb-3"><EffectsSummary result={revertPreview} /></div>
                <RevertForm jobId={id} version={String(revertPreview?.ledger_version ?? "")} fileName={job.file_name} />
              </Panel>
            )}
          </Section>
        </>
      )}
      {job.status === "reverted" && (
        <Section title="Geri alındı">
          <Callout tone="neutral" title={`Neden: ${job.revert_reason ?? "—"}`}>
            Bu aktarımın kayıtları iptal edildi. Aynı dosyayı yeniden yükleyebilirsiniz; mükerrer kayıt oluşmaz.
          </Callout>
        </Section>
      )}
      {job.status === "cancelled" && total === 0 && invoices.length === 0 && (
        <TableFrame><EmptyState title="Bu aktarım iptal edildi">Hiçbir kayıt oluşturulmadı.</EmptyState></TableFrame>
      )}
    </Page>
  );
}

function PreviewFacts({ kind, preview }: { kind: string; preview: Record<string, unknown> | null }) {
  if (!preview) return null;
  const items: Array<[string, ReactNode]> = [];
  if (kind === "product_list") {
    items.push(["Yeni ürün", String(preview.products_created ?? 0)], ["Güncellenen ürün", String(preview.products_updated ?? 0)],
      ["Açılış stoğu", String(preview.openings ?? 0)], ["Sayım farkı", String(preview.count_adjustments ?? 0)],
      ["Fiyat kaydı", String(preview.prices_recorded ?? 0)], ["KDV değişikliği", String(preview.vat_changes ?? 0)]);
  } else if (kind === "sales_summary" || kind === "sales_receipts") {
    items.push(["Satır", String(preview.rows ?? 0)], ["Net satış (KDV hariç)", <Money key="n" value={String(preview.net_sales ?? "0")} />]);
    if (preview.cogs !== undefined) items.push(["Satılan malın maliyeti", <Money key="c" value={String(preview.cogs)} />]);
    if (preview.period_start) items.push(["Dönem", `${formatDateShort(String(preview.period_start))} – ${formatDateShort(String(preview.period_end))}`]);
    if (preview.first_day) items.push(["Tarih aralığı", `${formatDateShort(String(preview.first_day))} – ${formatDateShort(String(preview.last_day))}`]);
  } else {
    items.push(["Fatura", String(preview.invoices ?? 0)], ["Satır", String(preview.lines ?? 0)], ["Toplam (KDV hariç)", <Money key="t" value={String(preview.total_excl_vat ?? "0")} />], ["Marj uyarısı", String(preview.margin_alerts ?? 0)]);
  }
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([k, v]) => (
        <div key={k} className="bg-surface p-3"><dt className="text-[12.5px] text-muted">{k}</dt><dd className="num mt-0.5 text-[16px] font-semibold">{v}</dd></div>
      ))}
    </dl>
  );
}
