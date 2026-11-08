/**
 * İşletmeler arası izolasyon: B işletmesinin kullanıcısı A'nın verisini hiçbir yoldan
 * göremez, değiştiremez, A'nın kayıtlarına bağlanamaz. Ayrıca defter tabloları
 * istemciden doğrudan yazılamaz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asUser, commit, fakeHash, one, rejects, resetDatabase, setupOrg, stageJob } from "./helpers";

let admin: Client;
let A: { user: string; org: string };
let B: { user: string; org: string };
let productA: string;
let jobA: string;
let itemA: string;
let expenseA: string;

beforeAll(async () => {
  resetDatabase();
  admin = await adminClient();
  A = await setupOrg(admin, "Market A");
  B = await setupOrg(admin, "Market B");
  await asUser(admin, A.user, async (q) => {
    const j = await stageJob(q, A.org, "product_list", { stock_date: "2026-10-01" }, [
      { parsed: { name: "Gizli Ürün", barcode: "111", base_unit: "adet", vat_rate: "20", stock_qty: "5",
                  list_purchase_price_net: "10", sale_price_gross: "18" } },
    ]);
    await commit(q, j);
    productA = (await one<{ id: string }>(q, "select id from public.products where barcode = '111'")).id;
    const inv = await one<{ id: string }>(q,
      "insert into public.import_jobs (organization_id, kind, file_name, file_hash) values ($1, 'purchase_invoice_xml', 'a.xml', $2) returning id",
      [A.org, fakeHash("a.xml")]);
    jobA = inv.id;
    await q("select public.stage_purchase_invoice($1, $2::jsonb, $3::jsonb)", [jobA,
      JSON.stringify({ supplier_name: "Tedarikçi A", invoice_no: "X1", invoice_date: "2026-10-02",
                       calc_total_excl_vat: "10", calc_total_vat: "2", calc_total_incl_vat: "12" }),
      JSON.stringify([{ line_no: 1, name: "Gizli Ürün", barcode: "111", unit_kind: "base", unit_base: "adet",
                        qty: "1", unit_price: "10", line_net: "10", vat_rate: "20", vat_amount: "2" }])]);
    itemA = (await one<{ id: string }>(q, "select id from public.purchase_items")).id;
    const cat = await one<{ id: string }>(q, "select id from public.expense_categories where code = 'rent'");
    expenseA = (await one<{ id: string }>(q,
      "insert into public.expenses (organization_id, category_id, month, amount) values ($1, $2, '2026-11-01', 5000) returning id",
      [A.org, cat.id])).id;
  });
});

afterAll(async () => {
  await admin.end();
});

describe("okuma izolasyonu", () => {
  it("B, A'nın hiçbir tablodaki verisini göremez", async () => {
    await asUser(admin, B.user, async (q) => {
      const tables = [
        "organizations", "organization_members", "products", "tax_rates", "product_price_history", "suppliers",
        "purchase_invoices", "purchase_items", "inventory_movements", "import_jobs", "import_rows", "expenses",
        "audit_log", "alerts", "cost_revisions", "product_overview",
      ];
      for (const t of tables) {
        const col = t === "organizations" ? "id" : "organization_id";
        const rows = await q(`select 1 from public.${t} where ${col} = $1`, [A.org]);
        expect(rows, t).toHaveLength(0);
      }
      const pnl = (await one<{ r: Record<string, string> }>(q, "select public.pnl_summary($1, '2026-10-01', '2026-12-31') as r", [A.org])).r;
      expect(pnl.stock_value).toBe("0");
      expect(await q("select * from public.product_profit($1, '2026-01-01', '2026-12-31')", [A.org])).toHaveLength(0);
      expect(await q("select * from public.stock_levels_at($1, '2026-12-31')", [A.org])).toHaveLength(0);
      expect(await q("select * from public.product_cost_history($1)", [productA])).toHaveLength(0);
    });
  });

  it("anonim kullanıcı hiçbir tabloyu okuyamaz", async () => {
    await admin.query("begin");
    try {
      await admin.query("set local role anon");
      await expect(admin.query("select * from public.products")).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("rollback");
    }
  });
});

describe("yazma izolasyonu", () => {
  it("B, A'nın işletmesine kayıt ekleyemez", async () => {
    await asUser(admin, B.user, async (q) => {
      await rejects(q, () => q("insert into public.products (organization_id, name, base_unit) values ($1, 'x', 'adet')", [A.org]),
        /row-level security/);
      await rejects(q, () => q("insert into public.import_jobs (organization_id, kind, file_name, file_hash) values ($1, 'product_list', 'x', $2)",
        [A.org, fakeHash("b1")]), /row-level security/);
      await rejects(q, () => q(
        "insert into public.import_rows (organization_id, job_id, row_number, raw, status) values ($1, $2, 1, '{}', 'ok')",
        [B.org, jobA]), /row-level security|bu işletmeye ait değil/);
    });
  });

  it("B, kendi kaydını A'nın kaydına bağlayamaz", async () => {
    await asUser(admin, B.user, async (q) => {
      await rejects(q, () => q("insert into public.product_units (organization_id, product_id, name, factor) values ($1, $2, 'koli', 24)",
        [B.org, productA]), /bu işletmeye ait değil/);
    });
  });

  it("B, A'nın kayıtlarını değiştiremez ve silemez", async () => {
    await asUser(admin, B.user, async (q) => {
      expect(await q("update public.expenses set amount = 1 where id = $1 returning id", [expenseA])).toHaveLength(0);
      expect(await q("delete from public.expenses where id = $1 returning id", [expenseA])).toHaveLength(0);
      expect(await q("update public.products set name = 'hack' where id = $1 returning id", [productA])).toHaveLength(0);
    });
  });

  it("B, A'nın verisi üzerinde hiçbir RPC çalıştıramaz", async () => {
    await asUser(admin, B.user, async (q) => {
      const calls: Array<[string, unknown[]]> = [
        ["select public.preview_commit($1)", [jobA]],
        ["select public.commit_import($1, null)", [jobA]],
        ["select public.preview_revert($1)", [jobA]],
        ["select public.cancel_import($1)", [jobA]],
        ["select public.stage_purchase_invoice($1, '{}'::jsonb, '[{}]'::jsonb)", [jobA]],
        ["select public.match_purchase_item($1, $2, '1', null, true)", [itemA, productA]],
        ["select public.ignore_purchase_item($1, true)", [itemA]],
        ["select public.add_manual_movement($1, 'waste', '1', '2026-11-01', null)", [productA]],
        ["select public.set_vat_rate($1, array[$2]::uuid[], '10', '2026-11-01')", [A.org, productA]],
        ["select public.close_period($1, '2026-10-01')", [A.org]],
        ["select public.reopen_period($1, '2026-10-01')", [A.org]],
        ["select public.generate_recurring_expenses($1, '2026-11-01')", [A.org]],
        ["select public.update_organization_settings($1, 'x', '1', 30, '1')", [A.org]],
      ];
      for (const [sql, params] of calls) {
        await rejects(q, () => q(sql, params), /erişim yetkiniz yok/);
      }
    });
  });
});

describe("defter tabloları sadece RPC ile yazılır", () => {
  it("işletme sahibi bile stok hareketi, satış, fatura durumunu doğrudan değiştiremez", async () => {
    await asUser(admin, A.user, async (q) => {
      await rejects(q, () => q(
        "insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type, qty) values ($1, $2, now(), 3, 'sale', -1)",
        [A.org, productA]), /permission denied/);
      await rejects(q, () => q("update public.inventory_movements set total_cost = 0"), /permission denied/);
      await rejects(q, () => q("delete from public.inventory_movements"), /permission denied/);
      await rejects(q, () => q("update public.purchase_invoices set status = 'posted'"), /permission denied/);
      await rejects(q, () => q("update public.import_jobs set status = 'committed'"), /permission denied/);
      await rejects(q, () => q("update public.organizations set closed_through = null"), /permission denied/);
      await rejects(q, () => q("insert into public.tax_rates (organization_id, product_id, rate, valid_from) values ($1, $2, 0, '2026-01-01')",
        [A.org, productA]), /permission denied/);
      await rejects(q, () => q("delete from public.audit_log"), /permission denied/);
    });
  });
});
