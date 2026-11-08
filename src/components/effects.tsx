import { dec } from "@/lib/domain/decimal";
import { formatMonth } from "@/lib/domain/format";
import { Callout, Money } from "./ui";

interface Revision { month: string; profit_delta: string; count: number; became_known: number; became_unknown: number }
interface Adjustment { month: string; profit_delta: string; products: number }

/** Bir aktarımın / geri almanın geçmiş kârlara etkisi: hiçbir değişiklik sessiz olmaz. */
export function EffectsSummary({ result, verb = "değişecek" }: { result: Record<string, unknown> | null; verb?: string }) {
  if (!result) return null;
  const revisions = (result.revisions as Revision[] | undefined) ?? [];
  const adjustments = (result.closed_adjustments as Adjustment[] | undefined) ?? [];
  if (revisions.length === 0 && adjustments.length === 0) {
    return <Callout tone="neutral" title="Geçmiş kârlar değişmiyor">Bu işlem daha önce hesaplanmış satışların maliyetini etkilemiyor.</Callout>;
  }
  return (
    <div className="flex flex-col gap-2">
      {revisions.map((r) => (
        <Callout key={`r-${r.month}`} tone="warn" title={`${formatMonth(r.month)} kârı ${verb}`}>
          {r.count} satış kaydının maliyeti yeniden hesaplanıyor.{" "}
          {!dec(r.profit_delta).isZero() && (
            <>Brüt kâra etkisi: <Money value={r.profit_delta} tone="auto" />.</>
          )}{" "}
          {r.became_known > 0 && <>{r.became_known} satışın maliyeti artık biliniyor. </>}
          {r.became_unknown > 0 && <>{r.became_unknown} satışın maliyeti artık bilinmiyor. </>}
        </Callout>
      ))}
      {adjustments.map((a) => (
        <Callout key={`a-${a.month}`} tone="info" title={`Kapalı dönem düzeltmesi: ${formatMonth(a.month)}`}>
          Kapalı aylardaki kayıtlar değişmez. Farkın kâra etkisi (<Money value={a.profit_delta} tone="auto" />, {a.products} ürün) {formatMonth(a.month)} tablosuna
          “geçmiş dönem maliyet düzeltmesi” satırı olarak yazılır.
        </Callout>
      ))}
    </div>
  );
}
