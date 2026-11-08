import { describe, expect, it } from "vitest";
import { forecastProduct, holt, weeklyBuckets, type ForecastInput, type SalesRecord } from "@/lib/domain/forecast";
import { addDays } from "@/lib/domain/dates";

const DATA_END = "2026-11-01";

function weekly(values: number[], end = DATA_END): SalesRecord[] {
  // values: eskiden yeniye
  const n = values.length;
  return values.map((v, i) => {
    const e = addDays(end, -7 * (n - 1 - i));
    return { start: addDays(e, -6), end: e, qty: String(v) };
  });
}

function input(over: Partial<ForecastInput> & { records: SalesRecord[] }): ForecastInput {
  const first = over.records.reduce((m, r) => (r.start < m ? r.start : m), over.records[0]?.start ?? DATA_END);
  return {
    dataEnd: DATA_END,
    coverage: [{ start: first, end: DATA_END }],
    productStart: first,
    stock: "14",
    onOrder: "0",
    leadTimeDays: 3,
    orderIntervalDays: 7,
    packSize: "24",
    packName: "Koli",
    baseUnit: "adet",
    minOrderQty: null,
    shelfLifeDays: null,
    markers: [],
    today: "2026-11-08",
    ...over,
  };
}

describe("Holt (ağırlıklı ortalama + eğilim)", () => {
  it("doğrusal seride bir sonraki değeri bulur", () => {
    // α=β=0,5; l0=10, b0=2 → l1=12, b1=2 → l2=14, b2=2 → tahmin 16
    expect(holt(["10", "12", "14"], "0.5", "0.5").forecast.toString()).toBe("16");
  });
  it("dalgalı seri elle hesap", () => {
    // l0=10, b0=4 → l1=0,5×14+0,5×14=14, b1=4 → l2=0,5×12+0,5×18=15, b2=0,5×1+0,5×4=2,5 → 17,5
    expect(holt(["10", "14", "12"], "0.5", "0.5").forecast.toString()).toBe("17.5");
  });
  it("sabit seride sabit kalır", () => {
    expect(holt(Array(8).fill("18")).forecast.toString()).toBe("18");
  });
});

describe("haftalık kovalar", () => {
  it("aylık toplamı günlere eşit dağıtır ve veri olmayan haftayı atlar", () => {
    const b = weeklyBuckets({
      dataEnd: "2026-10-31",
      coverage: [{ start: "2026-08-01", end: "2026-08-31" }, { start: "2026-10-01", end: "2026-10-31" }],
      productStart: "2026-08-01",
      records: [
        { start: "2026-08-01", end: "2026-08-31", qty: "310" },
        { start: "2026-10-01", end: "2026-10-31", qty: "310" },
      ],
      markers: [],
    });
    // Eylül yüklenmemiş: Eylül'e değen haftalar atlanır, sıfır satış sayılmaz
    expect(b.every((x) => x.qty.toString() === "70")).toBe(true);
    expect(b.length).toBe(8); // Ekim'de tam 4, Ağustos'ta tam 4 hafta
  });

  it("dönem çarpanı geçmiş satışı arındırır (Ramazan ×2)", () => {
    const b = weeklyBuckets({
      dataEnd: DATA_END, coverage: [{ start: addDays(DATA_END, -13), end: DATA_END }], productStart: null,
      records: weekly([40, 20]), markers: [{ start: addDays(DATA_END, -13), end: addDays(DATA_END, -7), multiplier: "2" }],
    });
    expect(b.map((x) => x.adjusted.toString())).toEqual(["20", "20"]);
  });
});

describe("sipariş önerisi", () => {
  it("örnek: haftada 18 adet, stok 14, teslim 3 + aralık 7 gün, koli 24 → 1 koli", () => {
    // Talep (10 gün) = 18/7 × 10 = 25,714 ; dalgalanma 0 → güvenlik stoğu 0
    // İhtiyaç = 25,714 − 14 = 11,714 → 1 koli (24 adet)
    const r = forecastProduct(input({ records: weekly(Array(8).fill(18)) }));
    expect(r.weeksOfData).toBe(8);
    expect(r.weeklyDemand?.toString()).toBe("18");
    expect(r.coverageDemand.toString()).toBe("25.714");
    expect(r.safetyStock.toString()).toBe("0");
    expect(r.suggestedUnits.toString()).toBe("1");
    expect(r.suggestedQty.toString()).toBe("24");
    expect([r.rangeLowUnits.toString(), r.rangeHighUnits.toString()]).toEqual(["1", "1"]);
    expect(r.confidence).toBe("low"); // 4–8 hafta → düşük
    expect(r.reason).toBe("Son 8 hafta: haftada ort. 18 adet. Stok 14 adet, teslim 3 gün + sipariş aralığı 7 gün. Öneri: 1 koli (24 adet).");
  });

  it("4 haftadan az veri → öneri yok", () => {
    const r = forecastProduct(input({ records: weekly([18, 18, 18]) }));
    expect(r.confidence).toBe("insufficient");
    expect(r.suggestedUnits.toString()).toBe("0");
    expect(r.reason).toMatch(/Yetersiz veri: 3 haftalık/);
  });

  it("düzenli ve uzun veri → yüksek güven, güvenlik stoğu dalgalanmaya göre", () => {
    const vals = [16, 20, 16, 20, 16, 20, 16, 20, 16, 20, 16, 20];
    const r = forecastProduct(input({ records: weekly(vals), packSize: "1", packName: null, stock: "0" }));
    expect(r.confidence).toBe("high");
    // σ (örneklem) = √(12 × 4 / 11) = 2,0889 ; GS = 1,65 × 2,0889 × √(10/7) = 4,120
    expect(r.sigmaWeekly?.toDecimalPlaces(4).toString()).toBe("2.0889");
    expect(r.safetyStock.toString()).toBe("4.12");
  });

  it("aylık toplam verisi → güven en fazla düşük", () => {
    const r = forecastProduct(input({
      dataEnd: "2026-10-31", today: "2026-10-31",
      coverage: [{ start: "2026-08-01", end: "2026-10-31" }], productStart: "2026-08-01",
      records: [
        { start: "2026-08-01", end: "2026-08-31", qty: "310" },
        { start: "2026-09-01", end: "2026-09-30", qty: "300" },
        { start: "2026-10-01", end: "2026-10-31", qty: "310" },
      ],
      stock: "0", leadTimeDays: 2, orderIntervalDays: 7, packSize: "1", packName: null,
    }));
    expect(r.granularity).toBe("coarse");
    expect(r.observations).toBe(3);
    expect(r.weeksOfData).toBe(13);
    expect(r.confidence).toBe("low");
    expect(r.suggestedQty.toString()).toBe("90"); // günde 10 × 9 gün
  });

  it("raf ömrü içinde satılamayacak miktar önerilmez", () => {
    // Günde 1 adet, raf ömrü 10 gün → en fazla 10 adet satılır; 1 koli (24) önerilemez
    const r = forecastProduct(input({ records: weekly(Array(6).fill(7)), stock: "0", shelfLifeDays: 10 }));
    expect(r.suggestedUnits.toString()).toBe("0");
    expect(r.notes.join(" ")).toMatch(/Raf ömrü \(10 gün\) içinde bir koli bile satılamıyor/);
  });

  it("stok yeterliyse sipariş yok ve kaç gün yeteceği yazılır", () => {
    const r = forecastProduct(input({ records: weekly(Array(8).fill(18)), stock: "100" }));
    expect(r.suggestedUnits.toString()).toBe("0");
    expect(r.reason).toMatch(/Stok yeterli \(yaklaşık 39 gün\)/); // 100 / (18/7) = 38,9
  });

  it("yoldaki sipariş ve minimum sipariş dikkate alınır", () => {
    const yolda = forecastProduct(input({ records: weekly(Array(8).fill(18)), onOrder: "12" }));
    expect(yolda.suggestedUnits.toString()).toBe("0"); // 25,7 − 14 − 12 < 0
    const min = forecastProduct(input({ records: weekly(Array(8).fill(18)), packSize: "1", packName: null, minOrderQty: "50" }));
    expect(min.suggestedQty.toString()).toBe("50");
  });

  it("işaretli dönem (×2) önümüzdeki talebi artırır", () => {
    const r = forecastProduct(input({
      records: weekly(Array(8).fill(18)),
      markers: [{ start: "2026-11-09", end: "2026-11-30", multiplier: "2" }],
    }));
    // 25,714 × 2 = 51,43 − 14 = 37,43 → 2 koli
    expect(r.suggestedUnits.toString()).toBe("2");
  });

  it("eksi stok 0 kabul edilir ve not düşülür", () => {
    const r = forecastProduct(input({ records: weekly(Array(8).fill(18)), stock: "-5" }));
    expect(r.notes[0]).toMatch(/Stok eksi/);
  });
});
