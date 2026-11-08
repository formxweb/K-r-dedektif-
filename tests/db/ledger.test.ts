/**
 * Maliyet zinciri, geçmiş tarihli kayıt, kapalı dönem, geri alma ve mükerrer kontrolü.
 * Beklenen değerler elle hesaplanmıştır (yorumlarda formüller).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asUser, commit, fakeHash, one, rejects, resetDatabase, revert, setupOrg, stageJob, type Q } from "./helpers";

let admin: Client;
let user: string;
let org: string;
let cay: string; // Çay 1 kg

const SUP = { supplier_name: "Toptancı A", supplier_tax_number: "1234567890" };

function line(no: number, qty: string, net: string, extra: Record<string, unknown> = {}) {
  return {
    line_no: no, name: "Çaykur Rize Turist 1 kg", code: "CAY1", barcode: "8690000000011",
    unit_code: "C62", unit_name: "Adet", unit_kind: "base", unit_base: "adet",
    qty, unit_price: (Number(net) / Number(qty)).toString(), discount_amount: "0",
    line_net: net, vat_rate: "1", vat_amount: (Number(net) / 100).toFixed(4), ...extra,
  };
}

async function stageInvoice(q: Q, invoiceNo: string, date: string, lines: unknown[], seed?: string) {
  const job = await one<{ id: string }>(
    q,
    `insert into public.import_jobs (organization_id, kind, file_name, file_hash) values ($1, 'purchase_invoice_xml', $2, $3) returning id`,
    [org, `${invoiceNo}.xml`, fakeHash(seed ?? invoiceNo + date)],
  );
  const header = { ...SUP, invoice_no: invoiceNo, invoice_date: date, calc_total_excl_vat: "0", calc_total_vat: "0", calc_total_incl_vat: "0", total_mismatch: false };
  const inv = await one<{ id: string }>(q, "select public.stage_purchase_invoice($1, $2::jsonb, $3::jsonb) as id", [job.id, JSON.stringify(header), JSON.stringify(lines)]);
  return { job: job.id, invoice: inv.id };
}

async function movements(q: Q, productId: string) {
  return q<{ movement_type: string; qty: string; total_cost: string | null; calc_total_cost: string | null; stock_after: string; avg_cost_after: string | null; cost_known: boolean; occurred_at: Date }>(
    `select movement_type, qty::text, total_cost::text, calc_total_cost::text, stock_after::text, avg_cost_after::text, cost_known, occurred_at
     from public.inventory_movements where product_id = $1 and voided_at is null order by occurred_at, priority, seq`,
    [productId],
  );
}

async function pnl(q: Q, from: string, to: string) {
  return (await one<{ r: Record<string, string> }>(q, "select public.pnl_summary($1, $2, $3) as r", [org, from, to])).r;
}

beforeAll(async () => {
  resetDatabase();
  admin = await adminClient();
  ({ user, org } = await setupOrg(admin, "Test Market"));
});

afterAll(async () => {
  await admin.end();
});

describe("açılış + alış + satış (açık dönem)", () => {
  it("ürün listesi açılış stoğunu ve maliyetini yazar", async () => {
    await asUser(admin, user, async (q) => {
      const job = await stageJob(q, org, "product_list", { stock_date: "2026-10-01" }, [
        { parsed: { name: "Çaykur Rize Turist 1 kg", barcode: "8690000000011", base_unit: "adet", vat_rate: "1",
                    sale_price_gross: "8.08", list_purchase_price_net: "5.00", stock_qty: "10" } },
      ]);
      const res = await commit(q, job);
      expect(res.products_created).toBe(1);
      expect(res.openings).toBe(1);
      cay = (await one<{ id: string }>(q, "select id from public.products where barcode = '8690000000011'")).id;
      const m = await movements(q, cay);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ movement_type: "opening", stock_after: "10.000", avg_cost_after: "5.0000" });
      // Hızlı yol: kayıtlı (booked) ve hesaplanan değerler aynı, satır ürüne bağlı
      const mv = await one<{ qty: string; total_cost: string; calc_total_cost: string; cost_known: boolean }>(
        q, "select qty::text, total_cost::text, calc_total_cost::text, cost_known from public.inventory_movements where product_id = $1", [cay]);
      expect(mv).toEqual({ qty: "10.000", total_cost: "50.0000", calc_total_cost: "50.0000", cost_known: true });
      const row = await one<{ product_id: string; target_type: string }>(q, "select product_id, target_type from public.import_rows where job_id = $1", [job]);
      expect(row).toEqual({ product_id: cay, target_type: "product" });
    });
  });

  it("alış ortalama maliyeti günceller: (10×5 + 120) / 30 = 5,6667", async () => {
    await asUser(admin, user, async (q) => {
      const { job } = await stageInvoice(q, "A-1", "2026-10-05", [line(1, "20", "120")]);
      const item = await one<{ match_status: string; match_method: string; unit_factor: string }>(
        q, "select match_status, match_method, unit_factor::text from public.purchase_items");
      expect(item).toEqual({ match_status: "matched", match_method: "barcode", unit_factor: "1.000" });
      await commit(q, job);
      const m = await movements(q, cay);
      expect(m[1]).toMatchObject({ movement_type: "purchase", stock_after: "30.000", avg_cost_after: "5.6667" });
    });
  });

  it("satış özeti satış anındaki maliyeti saklar: 15 × 5,6667 = 85,0005", async () => {
    await asUser(admin, user, async (q) => {
      const job = await stageJob(q, org, "sales_summary", { period_start: "2026-10-06", period_end: "2026-10-12" }, [
        { product_id: cay, parsed: { qty: "15", gross_amount: "121.20", net_amount: "120.00", vat_amount: "1.20", vat_rate: "1" } },
      ]);
      await commit(q, job);
      const s = await one<{ unit_cost: string; total_cost: string; cost_known: boolean }>(
        q, "select unit_cost::text, total_cost::text, cost_known from public.sales_period_summaries where import_job_id = $1", [job]);
      expect(s).toEqual({ unit_cost: "5.6667", total_cost: "85.0005", cost_known: true });
      const r = await pnl(q, "2026-10-01", "2026-10-31");
      expect(r.net_sales).toBe("120.0000");
      expect(r.cogs).toBe("85.0005");
      expect(r.stock_value).toBe("85.0005"); // 15 × 5,6667
      expect(r.covered_days).toBe(7);
    });
  });
});

describe("geçmiş tarihli alış (açık dönem)", () => {
  it("zinciri yeniden hesaplar, revizyon izi bırakır, marj uyarısı üretir", async () => {
    await asUser(admin, user, async (q) => {
      // 3 Ekim: 10 adet × 7 TL. Zincir: 10@5 → (50+70)/20 = 6 → (20×6+120)/40 = 6 → satış 15×6 = 90
      const { job } = await stageInvoice(q, "A-2", "2026-10-03", [line(1, "10", "70")]);
      const preview = (await one<{ r: Record<string, unknown> }>(q, "select public.preview_commit($1) as r", [job])).r;
      expect(preview.preview).toBe(true);
      const stillStaged = await one<{ status: string }>(q, "select status from public.import_jobs where id = $1", [job]);
      expect(stillStaged.status).toBe("staged");
      expect(preview.revisions).toEqual([
        { month: "2026-10-01", profit_delta: "-4.9995", count: 1, became_known: 0, became_unknown: 0 },
      ]);

      const res = await commit(q, job);
      expect(res.revisions).toEqual(preview.revisions);
      const s = await one<{ total_cost: string }>(q, "select total_cost::text from public.sales_period_summaries where status = 'active'");
      expect(s.total_cost).toBe("90.0000");
      const rev = await q("select old_total_cost::text, new_total_cost::text, cause_type from public.cost_revisions");
      expect(rev).toEqual([{ old_total_cost: "-85.0005", new_total_cost: "-90.0000", cause_type: "commit" }]);

      // Marj: satış 8,08 (KDV %1 → net 8,00). Eski (8−5)/8 = %37,5, yeni (8−7)/8 = %12,5
      // Önerilen: 8,08 × 7 / 5 = 11,312 → 0,50'ye yukarı → 11,50
      const a = await one<{ payload: Record<string, unknown> }>(q, "select payload from public.alerts where alert_type = 'margin_drop' and payload->>'invoice_no' = 'A-2'");
      expect(a.payload).toMatchObject({
        prev_cost: "5.0000", new_cost: "7.0000", cost_increase_pct: "40.00",
        old_margin_pct: "37.50", new_margin_pct: "12.50", suggested_price_gross: "11.5000",
        sale_price_changed_since_prev: false,
      });
      // Geçmiş ay (Ekim) kârı değiştiği için revizyon uyarısı
      const ra = await q("select alert_type from public.alerts where alert_type = 'cost_revision'");
      expect(ra).toHaveLength(1);
    });
  });

  it("önizlemeden sonra veri değişirse kesinleştirme reddedilir", async () => {
    await asUser(admin, user, async (q) => {
      const job = await stageJob(q, org, "sales_summary", { period_start: "2026-10-13", period_end: "2026-10-14" }, [
        { product_id: cay, parsed: { qty: "1", gross_amount: "8.08", net_amount: "8.00", vat_amount: "0.08", vat_rate: "1" } },
      ]);
      await rejects(q, () => q("select public.commit_import($1, 0)", [job]), /Önizlemeden sonra veriler değişti/);
      await q("select public.cancel_import($1)", [job]);
    });
  });
});

describe("kapalı dönem", () => {
  it("kapalı aydaki kâr değişmez; fark ilk açık aya düzeltme olarak yazılır", async () => {
    await asUser(admin, user, async (q) => {
      await q("select public.close_period($1, '2026-10-01')", [org]);
      // 4 Ekim: 5 × 5 TL. Zincir: 10@5 → 20@6 → (120+25)/25 = 5,8 → (25×5,8+120)/45 = 5,8889 → satış 15 × 5,8889 = 88,3335
      const { job } = await stageInvoice(q, "A-3", "2026-10-04", [line(1, "5", "25")]);
      const res = await commit(q, job);
      expect(res.revisions).toEqual([]);
      expect(res.closed_adjustments).toEqual([{ month: "2026-11-01", profit_delta: "1.6665", products: 1 }]);

      const s = await one<{ total_cost: string }>(q, "select total_cost::text from public.sales_period_summaries where status = 'active'");
      expect(s.total_cost).toBe("90.0000"); // kapalı dönem kaydı donuk
      const oct = await pnl(q, "2026-10-01", "2026-10-31");
      expect(oct.cogs).toBe("90.0000");
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.cost_adjustment).toBe("-1.6665"); // gider eksi → kâra +1,6665
    });
  });

  it("kapalı döneme satış eklenemez, kapalı dönem satışı geri alınamaz, gider eklenemez", async () => {
    await asUser(admin, user, async (q) => {
      const job = await stageJob(q, org, "sales_summary", { period_start: "2026-10-20", period_end: "2026-10-21" }, [
        { product_id: cay, parsed: { qty: "1", gross_amount: "8.08", net_amount: "8.00", vat_amount: "0.08", vat_rate: "1" } },
      ]);
      await rejects(q, () => commit(q, job), /kapalı döneme/);
      await q("select public.cancel_import($1)", [job]);
    });
    await asUser(admin, user, async (q) => {
      const salesJob = await one<{ id: string }>(q, "select id from public.import_jobs where kind = 'sales_summary' and status = 'committed'");
      await expect(revert(q, salesJob.id)).rejects.toThrow(/dönemi yeniden açın/);
    });
    await asUser(admin, user, async (q) => {
      const cat = await one<{ id: string }>(q, "select id from public.expense_categories where code = 'rent'");
      await expect(q("insert into public.expenses (organization_id, category_id, month, amount) values ($1, $2, '2026-10-01', 1000)", [org, cat.id]))
        .rejects.toThrow(/Bu ay kapalı/);
    });
  });

  it("dönemi yeniden açmak kayıtları güncel hesaba çeker ve düzeltmeyi kaldırır", async () => {
    await asUser(admin, user, async (q) => {
      const res = (await one<{ r: Record<string, number> }>(q, "select public.reopen_period($1, '2026-10-01') as r", [org])).r;
      expect(res).toEqual({ revisions: 1, adjustments: 0 });
      const oct = await pnl(q, "2026-10-01", "2026-10-31");
      expect(oct.cogs).toBe("88.3335");
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.cost_adjustment).toBe("0");
      await q("select public.close_period($1, '2026-10-01')", [org]);
    });
  });

  it("kapalı döneme etki eden alışı geri almak karşı düzeltme üretir", async () => {
    await asUser(admin, user, async (q) => {
      const a3 = await one<{ id: string }>(q, "select import_job_id as id from public.purchase_invoices where invoice_no = 'A-3'");
      const res = await revert(q, a3.id, "yanlış fatura");
      // Ekim kaydı 88,3335'te donuk, gerçek maliyet tekrar 90 → kâra −1,6665
      expect(res.closed_adjustments).toEqual([{ month: "2026-11-01", profit_delta: "-1.6665", products: 1 }]);
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.cost_adjustment).toBe("1.6665");
      const inv = await one<{ status: string }>(q, "select status from public.purchase_invoices where invoice_no = 'A-3'");
      expect(inv.status).toBe("reversed");
    });
  });
});

describe("mükerrer kontrolü ve geri alma", () => {
  let firstJob: string;

  it("aynı dosya işlenmişken tekrar yüklenemez", async () => {
    await asUser(admin, user, async (q) => {
      firstJob = await stageJob(q, org, "sales_summary", { period_start: "2026-11-01", period_end: "2026-11-02" }, [
        { product_id: cay, parsed: { qty: "5", gross_amount: "40.40", net_amount: "40.00", vat_amount: "0.40", vat_rate: "1" } },
      ], "kasim-1-2");
      await commit(q, firstJob);
    });
    await asUser(admin, user, async (q) => {
      await expect(stageJob(q, org, "sales_summary", {}, [], "kasim-1-2")).rejects.toThrow(/import_jobs_hash_uq/);
    });
  });

  it("çakışan dönem işlenemez", async () => {
    await asUser(admin, user, async (q) => {
      const job = await stageJob(q, org, "sales_summary", { period_start: "2026-11-02", period_end: "2026-11-03" }, [
        { product_id: cay, parsed: { qty: "1", gross_amount: "8.08", net_amount: "8.00", vat_amount: "0.08", vat_rate: "1" } },
      ]);
      await rejects(q, () => commit(q, job), /çakışan satış verisi/);
      await q("select public.cancel_import($1)", [job]);
    });
  });

  it("aynı fatura iki kez hazırlanamaz", async () => {
    await asUser(admin, user, async (q) => {
      await expect(stageInvoice(q, "A-1", "2026-10-05", [line(1, "20", "120")], "baska-dosya"))
        .rejects.toThrow(/zaten işlenmiş/);
    });
  });

  it("geri alınan aktarım tekrar işlenince mükerrer kayıt oluşmaz", async () => {
    await asUser(admin, user, async (q) => {
      const r = await revert(q, firstJob, "dosya yanlış");
      expect(r.voided_movements).toBe(1);
      const again = await stageJob(q, org, "sales_summary", { period_start: "2026-11-01", period_end: "2026-11-02" }, [
        { product_id: cay, parsed: { qty: "5", gross_amount: "40.40", net_amount: "40.00", vat_amount: "0.40", vat_rate: "1" } },
      ], "kasim-1-2");
      await commit(q, again);
      const active = await q("select id from public.sales_period_summaries where status = 'active' and period_start = '2026-11-01'");
      expect(active).toHaveLength(1);
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.net_sales).toBe("40.0000");
      // Zincir: Ekim sonu 25 @ 6,0000 → 5 satış = 30,0000
      expect(nov.cogs).toBe("30.0000");
    });
  });
});

describe("sayım farkı ve bilinmeyen maliyet", () => {
  it("yeni ürün listesi farkı onaylanırsa sayım farkı yazılır (anlık görüntü)", async () => {
    await asUser(admin, user, async (q) => {
      // Hesaplanan stok 20 (25 − 5). Liste 18 diyor → −2 × 6 = −12
      const job = await stageJob(q, org, "product_list", { stock_date: "2026-11-05" }, [
        { product_id: cay, parsed: { name: "Çaykur Rize Turist 1 kg", barcode: "8690000000011", base_unit: "adet", vat_rate: "1",
                                     sale_price_gross: "8.08", list_purchase_price_net: "6.00", stock_qty: "18", apply_count: true } },
      ]);
      const res = await commit(q, job);
      expect(res.count_adjustments).toBe(1);
      const m = await movements(q, cay);
      const c = m.find((x) => x.movement_type === "count_adjustment")!;
      expect(c).toMatchObject({ qty: "-2.000", total_cost: "-12.0000", stock_after: "18.000" });
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.count_diff).toBe("12.0000");
    });
  });

  it("maliyeti bilinmeyen satış kâra katılmaz; alış gelince maliyet bilinir", async () => {
    await asUser(admin, user, async (q) => {
      const listJob = await stageJob(q, org, "product_list", { stock_date: "2026-11-05" }, [
        { parsed: { name: "Ayçiçek Yağı 5 lt", barcode: "8690000000028", base_unit: "adet", vat_rate: "1" } },
      ]);
      await commit(q, listJob);
      const yag = (await one<{ id: string }>(q, "select id from public.products where barcode = '8690000000028'")).id;
      const sj = await stageJob(q, org, "sales_summary", { period_start: "2026-11-03", period_end: "2026-11-04" }, [
        { product_id: yag, parsed: { qty: "3", gross_amount: "909.00", net_amount: "900.00", vat_amount: "9.00", vat_rate: "1" } },
      ]);
      await commit(q, sj);
      let s = await one<{ cost_known: boolean }>(q, "select cost_known from public.sales_period_summaries where import_job_id = $1", [sj]);
      expect(s.cost_known).toBe(false);
      const nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.net_sales_unknown_cost).toBe("900.0000");

      const { job } = await stageInvoice(q, "B-1", "2026-11-02", [
        { ...line(1, "10", "2500"), name: "Ayçiçek Yağı 5 lt", code: "YAG5", barcode: "8690000000028" },
      ]);
      const res = await commit(q, job);
      expect(res.revisions).toEqual([{ month: "2026-11-01", profit_delta: "0", count: 1, became_known: 1, became_unknown: 0 }]);
      s = await one<{ cost_known: boolean }>(q, "select cost_known from public.sales_period_summaries where import_job_id = $1", [sj]);
      expect(s.cost_known).toBe(true);
    });
  });
});

describe("birim dönüşümü ve kayıtlı eşleşme", () => {
  it("koli birimi tanımsızsa fatura kesinleşmez; tanımlanınca eşleşme kaydedilir", async () => {
    await asUser(admin, user, async (q) => {
      const koli = { unit_code: "BX", unit_name: "Koli", unit_kind: "package", unit_base: null };
      const { job } = await stageInvoice(q, "C-1", "2026-11-06", [line(1, "2", "288", koli)]);
      const it = await one<{ id: string; match_status: string; unit_factor: string | null }>(
        q, "select id, match_status, unit_factor::text from public.purchase_items where invoice_id = (select id from public.purchase_invoices where invoice_no = 'C-1')");
      expect(it.match_status).toBe("matched");
      expect(it.unit_factor).toBeNull();
      await rejects(q, () => commit(q, job), /birim dönüşümü eksik/);

      await q("select public.match_purchase_item($1, $2, '24', 'Koli', true)", [it.id, cay]);
      const after = await one<{ base_qty: string; unit_cost_base: string }>(q, "select base_qty::text, unit_cost_base::text from public.purchase_items where id = $1", [it.id]);
      expect(after).toEqual({ base_qty: "48.000", unit_cost_base: "6.0000" }); // 288 / 48
      await commit(q, job);
      const ps = await one<{ order_unit_name: string; order_unit_factor: string }>(
        q, "select order_unit_name, order_unit_factor::text from public.product_suppliers where product_id = $1", [cay]);
      expect(ps).toEqual({ order_unit_name: "Koli", order_unit_factor: "24.000" });
    });
  });

  it("aynı tedarikçinin aynı ürünü bir daha sorulmaz", async () => {
    await asUser(admin, user, async (q) => {
      const koli = { unit_code: "BX", unit_name: "Koli", unit_kind: "package", unit_base: null, barcode: null };
      await stageInvoice(q, "C-2", "2026-11-07", [line(1, "1", "150", koli)]);
      const it = await one<{ match_status: string; match_method: string; unit_factor: string }>(
        q, "select match_status, match_method, unit_factor::text from public.purchase_items where invoice_id = (select id from public.purchase_invoices where invoice_no = 'C-2')");
      expect(it).toEqual({ match_status: "matched", match_method: "alias", unit_factor: "24.000" });
    });
  });
});

describe("elle stok hareketi", () => {
  it("fire kâr tablosuna ayrı satır olarak yazılır ve iptal edilebilir", async () => {
    await asUser(admin, user, async (q) => {
      const id = (await one<{ id: string }>(q, "select public.add_manual_movement($1, 'waste', '1', '2026-11-07', 'kırık paket') as id", [cay])).id;
      let nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(Number(nov.waste)).toBeGreaterThan(0);
      await q("select public.void_manual_movement($1, 'yanlış giriş')", [id]);
      nov = await pnl(q, "2026-11-01", "2026-11-30");
      expect(nov.waste).toBe("0");
    });
  });
});

describe("audit log", () => {
  it("kritik kayıtların değişiklik geçmişi tutulur", async () => {
    await asUser(admin, user, async (q) => {
      const rows = await q<{ table_name: string; n: string }>(
        "select table_name, count(*)::text as n from public.audit_log group by table_name order by table_name");
      const names = rows.map((r) => r.table_name);
      for (const t of ["import_jobs", "inventory_movements", "purchase_invoices", "sales_period_summaries", "organizations"]) {
        expect(names).toContain(t);
      }
    });
  });
});
