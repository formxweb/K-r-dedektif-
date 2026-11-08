import { describe, expect, it } from "vitest";
import { buildPnl, type PnlRaw } from "@/lib/domain/pnl";
import { formatNumber, formatPct, formatQty, formatSignedPct, formatTL } from "@/lib/domain/format";

const raw: PnlRaw = {
  from: "2026-10-01", to: "2026-10-31",
  net_sales: "10000.0000", net_sales_known_cost: "9500.0000", net_sales_unknown_cost: "500.0000", gross_sales: "10800",
  sales_rows: 40, unknown_cost_rows: 3,
  cogs: "7000.0000", waste: "100", spoilage: "50", count_diff: "25", cost_adjustment: "-10",
  shrink_unknown_rows: 0, rebates: "200", expenses: "1500", pending_expenses: 1,
  stock_value: "45000.5", stock_unknown_cost_products: 0, covered_days: 20, period_days: 31,
};

describe("kâr tablosu", () => {
  it("elle hesaplanan örnekle aynı sonucu verir", () => {
    const p = buildPnl(raw);
    // Brüt kâr = 9.500 − 7.000 = 2.500 (maliyeti bilinmeyen 500 TL'lik satış hariç)
    expect(p.grossProfit.toFixed(2)).toBe("2500.00");
    // Fire+bozulma+sayım = 100 + 50 + 25 = 175
    expect(p.shrinkage.toFixed(2)).toBe("175.00");
    // Faaliyet = 2.500 − 175 − (−10) + 200 − 1.500 = 1.035
    expect(p.operatingResult.toFixed(2)).toBe("1035.00");
    // Brüt marj = 2.500 / 9.500 = %26,3158
    expect(p.grossMarginPct?.toFixed(4)).toBe("26.3158");
    expect(p.lines.map((l) => l.key)).toEqual([
      "net_sales", "cogs", "gross_profit", "shrinkage", "cost_adjustment", "rebates", "expenses", "operating_result",
    ]);
    expect(p.lines.find((l) => l.key === "operating_result")?.hint).toBe("giderlerden sonra kalan");
  });

  it("eksik veriyi uyarı olarak söyler", () => {
    const keys = buildPnl(raw).warnings.map((w) => w.key);
    expect(keys).toEqual(["unknown_cost", "coverage", "pending_expenses"]);
  });

  it("veri yoksa hasData false", () => {
    const p = buildPnl({ ...raw, net_sales: "0", net_sales_known_cost: "0", net_sales_unknown_cost: "0", sales_rows: 0,
      unknown_cost_rows: 0, cogs: "0", waste: "0", spoilage: "0", count_diff: "0", cost_adjustment: "0", rebates: "0",
      expenses: "0", pending_expenses: 0, covered_days: 0 });
    expect(p.hasData).toBe(false);
    expect(p.warnings).toEqual([]);
  });
});

describe("biçimlendirme", () => {
  it("TL biçimi: 12.450,75 ₺", () => {
    expect(formatTL("12450.75")).toBe("12.450,75 ₺");
    expect(formatTL("12450.755")).toBe("12.450,76 ₺");
    expect(formatTL("-1234567.8")).toBe("−1.234.567,80 ₺");
    expect(formatTL("0")).toBe("0,00 ₺");
    expect(formatTL(null)).toBe("—");
    expect(formatNumber("999.995", 2)).toBe("1.000,00");
  });

  it("miktar ve yüzde", () => {
    expect(formatQty("24.000", "adet")).toBe("24 adet");
    expect(formatQty("1.250", "kg")).toBe("1,25 kg");
    expect(formatPct("12.5")).toBe("%12,5");
    expect(formatSignedPct("10")).toBe("+%10,0");
    expect(formatSignedPct("-4.25", 2)).toBe("−%4,25");
  });
});
