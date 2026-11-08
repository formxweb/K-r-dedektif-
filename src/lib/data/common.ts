import "server-only";
import type { Supa } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/errors";

/** PostgREST sayfa sınırını (1000 satır) aşmak için sayfa sayfa okur. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>,
  pageSize = 1000,
  max = 100_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(friendlyError(error));
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export interface ProductRow {
  id: string;
  name: string;
  name_norm: string | null;
  barcode: string | null;
  code: string | null;
  base_unit: "adet" | "kg" | "lt";
}

export async function loadProducts(supabase: Supa, orgId: string): Promise<ProductRow[]> {
  return fetchAll<ProductRow>((from, to) =>
    supabase.from("products").select("id, name, name_norm, barcode, code, base_unit").eq("organization_id", orgId).order("id").range(from, to),
  );
}

export interface TaxRow {
  product_id: string;
  rate: string;
  valid_from: string;
  valid_to: string | null;
}

export async function loadVatLookup(supabase: Supa, orgId: string): Promise<(productId: string, date: string) => string | null> {
  const rows = await fetchAll<TaxRow>((from, to) =>
    supabase.from("tax_rates").select("product_id, rate::text, valid_from, valid_to").eq("organization_id", orgId).order("id").range(from, to),
  );
  const byProduct = new Map<string, TaxRow[]>();
  for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);
  return (productId, date) => {
    const list = byProduct.get(productId);
    if (!list) return null;
    const hit = list.find((r) => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date));
    return hit ? hit.rate : null;
  };
}
