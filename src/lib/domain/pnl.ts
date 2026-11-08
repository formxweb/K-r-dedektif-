import { dec, money, type Dec } from "./decimal";

/** pnl_summary() RPC çıktısı (tüm sayılar metin) */
export interface PnlRaw {
  from: string;
  to: string;
  net_sales: string;
  net_sales_known_cost: string;
  net_sales_unknown_cost: string;
  gross_sales: string;
  sales_rows: number;
  unknown_cost_rows: number;
  cogs: string;
  waste: string;
  spoilage: string;
  count_diff: string;
  cost_adjustment: string;
  shrink_unknown_rows: number;
  rebates: string;
  expenses: string;
  pending_expenses: number;
  stock_value: string;
  stock_unknown_cost_products: number;
  covered_days: number;
  period_days: number;
}

export interface PnlLine {
  key: string;
  label: string;
  hint?: string;
  amount: Dec;
  /** gösterimde: + gelir, − gider, = ara toplam */
  sign: "+" | "-" | "=";
  emphasis?: boolean;
  hideIfZero?: boolean;
}

export interface PnlWarning {
  key: string;
  text: string;
}

export interface Pnl {
  netSales: Dec;
  netSalesKnownCost: Dec;
  netSalesUnknownCost: Dec;
  cogs: Dec;
  grossProfit: Dec;
  grossMarginPct: Dec | null;
  shrinkage: Dec;
  costAdjustment: Dec;
  rebates: Dec;
  expenses: Dec;
  operatingResult: Dec;
  stockValue: Dec;
  lines: PnlLine[];
  warnings: PnlWarning[];
  hasData: boolean;
}

/**
 * Kâr tablosu:
 *   Net satış (KDV hariç, iadeler düşülmüş — maliyeti bilinen satışlar)
 *   − Satılan malın maliyeti
 *   = Brüt kâr
 *   − Fire, bozulma ve sayım farkı
 *   − Geçmiş dönem maliyet düzeltmesi (varsa)
 *   + Tedarikçi primleri
 *   − İşletme giderleri
 *   = Faaliyet sonucu
 * Maliyeti bilinmeyen satışlar kâra katılmaz, ayrıca gösterilir.
 */
export function buildPnl(r: PnlRaw): Pnl {
  const netSales = money(r.net_sales);
  const known = money(r.net_sales_known_cost);
  const unknown = money(r.net_sales_unknown_cost);
  const cogs = money(r.cogs);
  const grossProfit = money(known.minus(cogs));
  const waste = money(r.waste);
  const spoilage = money(r.spoilage);
  const countDiff = money(r.count_diff);
  const shrinkage = money(waste.plus(spoilage).plus(countDiff));
  const costAdjustment = money(r.cost_adjustment);
  const rebates = money(r.rebates);
  const expenses = money(r.expenses);
  const operatingResult = money(grossProfit.minus(shrinkage).minus(costAdjustment).plus(rebates).minus(expenses));

  const lines: PnlLine[] = [
    { key: "net_sales", label: "Net satış", hint: "KDV hariç, iadeler düşülmüş", amount: known, sign: "+" },
    { key: "cogs", label: "Satılan malın maliyeti", hint: "satış anındaki ortalama maliyetle", amount: cogs, sign: "-" },
    { key: "gross_profit", label: "Brüt kâr", hint: "mal satışından kalan", amount: grossProfit, sign: "=", emphasis: true },
    { key: "shrinkage", label: "Fire, bozulma ve sayım farkı", amount: shrinkage, sign: "-" },
    { key: "cost_adjustment", label: "Geçmiş dönem maliyet düzeltmesi", hint: "kapalı aylara ait geç gelen maliyet farkı", amount: costAdjustment, sign: "-", hideIfZero: true },
    { key: "rebates", label: "Tedarikçi primleri", amount: rebates, sign: "+", hideIfZero: true },
    { key: "expenses", label: "İşletme giderleri", hint: "kira, personel, faturalar…", amount: expenses, sign: "-" },
    { key: "operating_result", label: "Faaliyet sonucu", hint: "giderlerden sonra kalan", amount: operatingResult, sign: "=", emphasis: true },
  ];

  const warnings: PnlWarning[] = [];
  if (r.unknown_cost_rows > 0) {
    warnings.push({
      key: "unknown_cost",
      text: `${r.unknown_cost_rows} satış kaydının maliyeti bilinmiyor; bu satışlar (${unknown.toFixed(2)} ₺) kâra katılmadı. Bu ürünlerin alış faturasını veya açılış stoğunu yükleyin.`,
    });
  }
  if (r.sales_rows > 0 && r.covered_days < r.period_days) {
    warnings.push({ key: "coverage", text: `Satış verisi bu dönemin ${r.period_days} gününden ${r.covered_days} gününü kapsıyor.` });
  }
  if (r.pending_expenses > 0) {
    warnings.push({ key: "pending_expenses", text: `${r.pending_expenses} tekrarlayan gider onay bekliyor; onaylanana kadar kâra yansımaz.` });
  }
  if (r.shrink_unknown_rows > 0) {
    warnings.push({ key: "shrink_unknown", text: `${r.shrink_unknown_rows} fire/sayım kaydının maliyeti bilinmediği için tabloya girmedi.` });
  }
  if (r.stock_unknown_cost_products > 0) {
    warnings.push({ key: "stock_unknown", text: `${r.stock_unknown_cost_products} ürünün maliyeti bilinmediği için stok değerine eklenmedi.` });
  }

  return {
    netSales,
    netSalesKnownCost: known,
    netSalesUnknownCost: unknown,
    cogs,
    grossProfit,
    grossMarginPct: known.gt(0) ? grossProfit.div(known).times(100) : null,
    shrinkage,
    costAdjustment,
    rebates,
    expenses,
    operatingResult,
    stockValue: money(r.stock_value),
    lines,
    warnings,
    hasData: r.sales_rows > 0 || dec(r.expenses).gt(0),
  };
}
