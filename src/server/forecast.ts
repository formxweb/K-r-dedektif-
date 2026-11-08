"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/session";
import { friendlyError, type ActionState } from "@/lib/errors";
import { fetchAll } from "@/lib/data/common";
import { addDays, istToday } from "@/lib/domain/dates";
import { FORECAST_VERSION, forecastProduct, type PeriodMarker, type SalesRecord } from "@/lib/domain/forecast";

interface Ov { id: string; name: string; base_unit: string; category_id: string | null; shelf_life_days: number | null; stock_qty: string | null; first_movement_at: string | null }

function mergeRanges(ranges: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : 1));
  const out: Array<{ start: string; end: string }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= addDays(last.end, 1)) {
      if (r.end > last.end) last.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

export async function runForecast(_: ActionState | undefined): Promise<ActionState> {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const today = istToday();
  const from = addDays(today, -26 * 7 - 14);

  const [history, products, links, suppliers, onOrder, markers] = await Promise.all([
    fetchAll<{ product_id: string; period_start: string; period_end: string; qty: string }>((a, b) => supabase.rpc("sales_history", { p_org: org.id, p_from: from }).range(a, b)),
    fetchAll<Ov>((a, b) => supabase.from("product_overview").select("id, name, base_unit, category_id, shelf_life_days, stock_qty, first_movement_at").eq("organization_id", org.id).eq("is_active", true).order("id").range(a, b)),
    fetchAll<{ product_id: string; supplier_id: string; order_unit_name: string | null; order_unit_factor: string | null; min_order_qty: string | null }>((a, b) =>
      supabase.from("product_suppliers").select("product_id, supplier_id, order_unit_name, order_unit_factor::text, min_order_qty::text").eq("organization_id", org.id).eq("is_primary", true).order("id").range(a, b)),
    supabase.from("suppliers").select("id, lead_time_days, order_interval_days").eq("organization_id", org.id),
    fetchAll<{ product_id: string; qty: string }>((a, b) => supabase.rpc("on_order_quantities", { p_org: org.id }).range(a, b)),
    supabase.from("period_markers").select("start_date, end_date, multiplier::text, category_id").eq("organization_id", org.id),
  ]);
  if (history.length === 0) return { error: "Satış verisi yok. Öneri için en az 4 haftalık satış raporu yükleyin." };
  if (suppliers.error || markers.error) return { error: friendlyError(suppliers.error ?? markers.error) };

  const dataEnd = history.reduce((m, h) => (h.period_end > m ? h.period_end : m), history[0]!.period_end);
  const coverage = mergeRanges(history.map((h) => ({ start: h.period_start, end: h.period_end })));
  const byProduct = new Map<string, SalesRecord[]>();
  for (const h of history) byProduct.set(h.product_id, [...(byProduct.get(h.product_id) ?? []), { start: h.period_start, end: h.period_end, qty: h.qty }]);
  const linkBy = new Map(links.map((l) => [l.product_id, l]));
  const supBy = new Map((suppliers.data ?? []).map((s) => [s.id, s]));
  const orderBy = new Map(onOrder.map((o) => [o.product_id, o.qty]));
  const mk = (markers.data ?? []).map((m) => ({ start: m.start_date, end: m.end_date, multiplier: m.multiplier, category_id: m.category_id }));

  const { data: run, error: runErr } = await supabase
    .from("forecast_runs")
    .insert({ organization_id: org.id, algorithm_version: FORECAST_VERSION, params: { today, data_end: dataEnd }, data_summary: { products: byProduct.size, coverage } })
    .select("id")
    .single();
  if (runErr) return { error: friendlyError(runErr) };

  const items: Record<string, unknown>[] = [];
  for (const p of products) {
    const records = byProduct.get(p.id);
    if (!records) continue;
    const link = linkBy.get(p.id);
    const sup = link ? supBy.get(link.supplier_id) : undefined;
    const pm: PeriodMarker[] = mk.filter((m) => !m.category_id || m.category_id === p.category_id);
    const lead = sup?.lead_time_days ?? 2;
    const interval = sup?.order_interval_days ?? 7;
    const r = forecastProduct({
      dataEnd, coverage, productStart: p.first_movement_at ? p.first_movement_at.slice(0, 10) : null, records,
      stock: p.stock_qty ?? "0", onOrder: orderBy.get(p.id) ?? "0", leadTimeDays: lead, orderIntervalDays: interval,
      packSize: link?.order_unit_factor ?? null, packName: link?.order_unit_name ?? null, baseUnit: p.base_unit,
      minOrderQty: link?.min_order_qty ?? null, shelfLifeDays: p.shelf_life_days, markers: pm, today,
    });
    items.push({
      organization_id: org.id, run_id: run.id, product_id: p.id, supplier_id: link?.supplier_id ?? null,
      weekly_demand: r.weeklyDemand?.toDecimalPlaces(3).toString() ?? null, trend_pct: r.trendPct?.toDecimalPlaces(4).toString() ?? null,
      weeks_of_data: r.weeksOfData, observations: r.observations, stock_on_hand: p.stock_qty ?? "0", on_order: orderBy.get(p.id) ?? "0",
      safety_stock: r.safetyStock.toString(), suggested_qty: r.suggestedQty.toString(),
      order_unit_name: link?.order_unit_name ?? null, order_unit_factor: r.packSize.toString(),
      suggested_units: r.suggestedUnits.toString(), range_low_units: r.rangeLowUnits.toString(), range_high_units: r.rangeHighUnits.toString(),
      confidence: r.confidence, reason: r.reason,
      inputs: { lead_time_days: lead, order_interval_days: interval, granularity: r.granularity, notes: r.notes, avg_weekly: r.avgWeekly?.toDecimalPlaces(3).toString() ?? null, data_end: dataEnd },
    });
  }
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await supabase.from("forecast_items").insert(items.slice(i, i + 500));
    if (error) return { error: friendlyError(error) };
  }
  revalidatePath("/siparis-onerileri");
  revalidatePath("/genel-bakis");
  redirect("/siparis-onerileri");
}

export async function markOrdered(form: FormData): Promise<void> {
  const supabase = await createClient();
  const runId = String(form.get("run_id"));
  const supplierId = String(form.get("supplier_id") ?? "");
  const rows = await fetchAll<{ id: string; suggested_qty: string }>((a, b) => {
    let q = supabase.from("forecast_items").select("id, suggested_qty::text").eq("run_id", runId).gt("suggested_units", 0).is("ordered_at", null);
    q = supplierId ? q.eq("supplier_id", supplierId) : q.is("supplier_id", null);
    return q.order("id").range(a, b);
  });
  const now = new Date().toISOString();
  for (const r of rows) await supabase.from("forecast_items").update({ ordered_at: now, ordered_qty: r.suggested_qty }).eq("id", r.id);
  revalidatePath("/siparis-onerileri");
}
