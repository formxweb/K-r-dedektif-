import { describe, expect, it } from "vitest";
import { addVat, splitGross, toNet } from "@/lib/domain/vat";
import { resolveUnit, toBaseQty, unitCost, unitFactor } from "@/lib/domain/units";

describe("KDV", () => {
  it("KDV dahil tutarı ayırır; net + KDV = brüt", () => {
    expect(splitGross("121.20", "1")).toEqual({ net: expect.anything(), vat: expect.anything() });
    const a = splitGross("121.20", "1");
    expect(a.net.toFixed(4)).toBe("120.0000");
    expect(a.vat.toFixed(4)).toBe("1.2000");
    const b = splitGross("100", "20"); // 100 / 1,20 = 83,33333…
    expect(b.net.toFixed(4)).toBe("83.3333");
    expect(b.vat.toFixed(4)).toBe("16.6667");
    expect(b.net.plus(b.vat).toFixed(4)).toBe("100.0000");
    const c = splitGross("12.99", "10"); // 12,99 / 1,1 = 11,80909…
    expect(c.net.toFixed(4)).toBe("11.8091");
    expect(c.vat.toFixed(4)).toBe("1.1809");
  });

  it("KDV hariç tutara KDV ekler", () => {
    const r = addVat("83.3333", "20"); // 83,3333 × 0,20 = 16,66666 → 16,6667
    expect(r.vat.toFixed(4)).toBe("16.6667");
    expect(r.gross.toFixed(4)).toBe("100.0000");
  });

  it("profildeki 'KDV dahil mi' ayarına göre çevirir", () => {
    const hariç = toNet("50", "10", false);
    expect([hariç.net.toFixed(2), hariç.vat.toFixed(2), hariç.gross.toFixed(2)]).toEqual(["50.00", "5.00", "55.00"]);
    const dahil = toNet("55", "10", true);
    expect([dahil.net.toFixed(2), dahil.vat.toFixed(2), dahil.gross.toFixed(2)]).toEqual(["50.00", "5.00", "55.00"]);
    expect(() => splitGross("10", "-1")).toThrow();
  });

  it("%0 KDV'de net = brüt", () => {
    expect(splitGross("10.50", "0").net.toFixed(4)).toBe("10.5000");
  });
});

describe("birim dönüşümü", () => {
  it("UBL birim kodlarını ve Türkçe adları tanır", () => {
    expect(resolveUnit("C62")).toMatchObject({ kind: "base", base: "adet" });
    expect(resolveUnit("KGM")).toMatchObject({ kind: "base", base: "kg" });
    expect(resolveUnit("GRM").scale?.toString()).toBe("0.001");
    expect(resolveUnit("koli")).toMatchObject({ kind: "package", label: "Koli" });
    expect(resolveUnit("Koli")).toMatchObject({ kind: "package", label: "Koli" });
    expect(resolveUnit("BX")).toMatchObject({ kind: "package", label: "Kutu" });
    expect(resolveUnit("")).toMatchObject({ kind: "unknown" });
    expect(resolveUnit("XYZ")).toMatchObject({ kind: "unknown", label: "XYZ" });
  });

  it("katsayıyı bulur, tanımsızsa null döner (kullanıcıya sorulur)", () => {
    expect(unitFactor(resolveUnit("C62"), "adet")?.toString()).toBe("1");
    expect(unitFactor(resolveUnit("GRM"), "kg")?.toString()).toBe("0.001");
    expect(unitFactor(resolveUnit("Koli"), "adet", [{ name: "koli", factor: "24" }])?.toString()).toBe("24");
    expect(unitFactor(resolveUnit("Koli"), "adet", [])).toBeNull();
    expect(unitFactor(resolveUnit("KGM"), "adet")).toBeNull(); // kg faturası, adetli ürün
  });

  it("temel birim miktarı ve birim maliyet", () => {
    expect(toBaseQty("2", "24").toFixed(3)).toBe("48.000");
    expect(toBaseQty("1500", "0.001").toFixed(3)).toBe("1.500");
    expect(unitCost("288", "48").toFixed(4)).toBe("6.0000");
    expect(unitCost("100", "3").toFixed(4)).toBe("33.3333");
    expect(() => toBaseQty("1", "0")).toThrow();
    expect(() => unitCost("1", "0")).toThrow();
  });
});
