import { describe, expect, it } from "vitest";
import { compareTotals, computeLine, distributeDocDiscount, invoiceTotals } from "@/lib/domain/invoice";
import { marginPct, markupPct, priceForTargetMargin, suggestedPriceKeepingMargin } from "@/lib/domain/margin";

describe("fatura satırı ve toplamları", () => {
  it("satır neti = miktar × fiyat − iskonto; KDV netten", () => {
    const l = computeLine({ qty: "10", unitPrice: "12.50", discountAmount: "5", vatRate: "1" });
    expect(l.grossBeforeDiscount.toFixed(4)).toBe("125.0000");
    expect(l.lineNet.toFixed(4)).toBe("120.0000");
    expect(l.vatAmount.toFixed(4)).toBe("1.2000");
    const p = computeLine({ qty: "10", unitPrice: "12.50", discountPct: "10", vatRate: "20" });
    expect(p.lineNet.toFixed(4)).toBe("112.5000");
    expect(p.vatAmount.toFixed(4)).toBe("22.5000");
  });

  it("belgedeki satır tutarı varsa esas alınır", () => {
    const l = computeLine({ qty: "3", unitPrice: "3.3333", docLineNet: "10.00", docVatAmount: "0.10", vatRate: "1" });
    expect(l.lineNet.toFixed(4)).toBe("10.0000");
    expect(l.vatAmount.toFixed(4)).toBe("0.1000");
  });

  it("belge iskontosu satırlara oranında, kuruşu kuruşuna dağıtılır", () => {
    // 10 × 100/600,01 = 1,66664 → 1,6666 ; 3,33328 → 3,3333 ; 5,00008 → 5,0001
    expect(distributeDocDiscount(["100", "200", "300.01"], "10").map((x) => x.toFixed(4))).toEqual(["1.6666", "3.3333", "5.0001"]);
    // 1/3 = 0,3333 × 3 = 0,9999 → artık 0,0001 en büyük satıra
    expect(distributeDocDiscount(["1", "1", "1"], "1").map((x) => x.toFixed(4))).toEqual(["0.3334", "0.3333", "0.3333"]);
    expect(distributeDocDiscount(["5", "5"], "0").map((x) => x.toFixed(4))).toEqual(["0.0000", "0.0000"]);
  });

  it("toplamlar satırlardan hesaplanır, 0,05 TL üstü fark uyarı verir", () => {
    const t = invoiceTotals([{ lineNet: "120", vatAmount: "1.2" }, { lineNet: "112.5", vatAmount: "1.125" }]);
    expect([t.exclVat.toFixed(4), t.vat.toFixed(4), t.inclVat.toFixed(4)]).toEqual(["232.5000", "2.3250", "234.8250"]);
    expect(compareTotals({ inclVat: "234.87" }, t).mismatch).toBe(false); // fark 0,045
    expect(compareTotals({ inclVat: "234.875" }, t).mismatch).toBe(false); // fark tam 0,05
    const bad = compareTotals({ inclVat: "234.90", exclVat: "232.50" }, t); // fark 0,075
    expect(bad.mismatch).toBe(true);
    expect(bad.diffs.inclVat?.toFixed(4)).toBe("0.0750");
    expect(compareTotals({}, t).mismatch).toBe(false);
  });
});

describe("marj ve fiyat önerisi", () => {
  it("marj satış fiyatı üzerinden, KDV hariç", () => {
    // 8,08 / 1,01 = 8,00 → (8 − 5) / 8 = %37,5 ; maliyet üstü (8 − 5) / 5 = %60
    expect(marginPct("8.08", "1", "5")?.toFixed(2)).toBe("37.50");
    expect(markupPct("8.08", "1", "5")?.toFixed(2)).toBe("60.00");
    expect(marginPct("0", "1", "5")).toBeNull();
  });

  it("eski marjı koruyan fiyat: 8,08 × 7 / 5 = 11,312 → 11,50", () => {
    expect(suggestedPriceKeepingMargin("8.08", "5", "7", "0.50")?.toFixed(2)).toBe("11.50");
    expect(suggestedPriceKeepingMargin("8.08", "5", "7", "0.25")?.toFixed(2)).toBe("11.50");
    expect(suggestedPriceKeepingMargin("8.08", "5", "7", "0.01")?.toFixed(2)).toBe("11.32");
    expect(suggestedPriceKeepingMargin("8.08", "0", "7", "0.5")).toBeNull();
  });

  it("hedef marj için fiyat: 7 / (1 − 0,375) × 1,01 = 11,312 → 11,50", () => {
    expect(priceForTargetMargin("7", "37.5", "1", "0.5")?.toFixed(2)).toBe("11.50");
    expect(priceForTargetMargin("7", "100", "1", "0.5")).toBeNull();
  });
});
