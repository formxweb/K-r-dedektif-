import Link from "next/link";
import { formatDate, formatMonth } from "@/lib/domain/format";
import { Money, Pct } from "./ui";

export interface AlertRow {
  id: string;
  alert_type: string;
  payload: Record<string, unknown>;
  product_id: string | null;
  created_at: string;
  status?: string;
  products: { name: string } | null;
}

/** Uyarının tek satırlık, sade Türkçe açıklaması */
export function AlertLine({ alert }: { alert: AlertRow }) {
  const p = alert.payload as Record<string, string>;
  if (alert.alert_type === "margin_drop") {
    return (
      <div className="flex flex-col gap-0.5 text-[14px]">
        <Link href={`/urunler/${alert.product_id}`} className="font-medium text-accent hover:underline">{alert.products?.name ?? "Ürün"}</Link>
        <span>
          Alış fiyatı <Pct value={p.cost_increase_pct} /> arttı, satış fiyatı {p.sale_price_changed_since_prev ? "güncellendi ama yetmedi" : "aynı"}.
        </span>
        <span className="text-muted">
          Marj <Pct value={p.old_margin_pct} /> → <span className="text-neg"><Pct value={p.new_margin_pct} /></span>.
          {p.suggested_price_gross && <> Eski marjı korumak için önerilen satış fiyatı: <strong className="text-text"><Money value={p.suggested_price_gross} /></strong></>}
        </span>
        <span className="text-[12px] text-faint">{p.supplier} · fatura {p.invoice_no} · {formatDate(p.invoice_date)} · satış fiyatı {formatDate(p.sale_price_date)} tarihli listeden</span>
      </div>
    );
  }
  if (alert.alert_type === "invoice_total_mismatch") {
    return (
      <div className="text-[14px]">
        <span className="font-medium">Fatura toplamı tutmuyor</span> — {p.supplier} {p.invoice_no}: belgede <Money value={p.doc_total_incl_vat} />, satırlardan <Money value={p.calc_total_incl_vat} />.
      </div>
    );
  }
  if (alert.alert_type === "cost_revision" || alert.alert_type === "closed_period_adjustment") {
    const revs = (alert.payload.revisions as Array<{ month: string; profit_delta: string }> | undefined) ?? [];
    const adj = (alert.payload.closed_adjustments as Array<{ month: string; profit_delta: string }> | undefined) ?? [];
    return (
      <div className="flex flex-col gap-0.5 text-[14px]">
        <span className="font-medium">Geçmiş ayın kârı değişti</span>
        <span className="text-muted">
          “{String(alert.payload.file_name ?? "aktarım")}” {alert.payload.cause === "revert" ? "geri alındığı" : "işlendiği"} için maliyetler yeniden hesaplandı.
          {revs.map((r) => <span key={r.month}> {formatMonth(r.month)}: <Money value={r.profit_delta} tone="auto" />.</span>)}
          {adj.map((a) => <span key={a.month}> Kapalı dönem farkı {formatMonth(a.month)} tablosuna yazıldı: <Money value={a.profit_delta} tone="auto" />.</span>)}
        </span>
      </div>
    );
  }
  return <span className="text-[14px]">{alert.alert_type}</span>;
}
