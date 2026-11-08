"use client";

import { useActionState } from "react";
import { addMovement, addUnit, setProductSupplier, setProductVat, updateProduct } from "@/server/products";
import { Field, Input, Select } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

export function MovementForm({ productId, unit, today, minDate }: { productId: string; unit: string; today: string; minDate?: string }) {
  const [state, action] = useActionState(addMovement, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <input type="hidden" name="product_id" value={productId} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Tür" htmlFor="type">
          <Select id="type" name="type" defaultValue="waste">
            <option value="waste">Fire</option>
            <option value="spoilage">Bozulma / son kullanma</option>
            <option value="supplier_return">Tedarikçiye iade</option>
            <option value="count_adjustment">Sayım (sayılan miktar)</option>
          </Select>
        </Field>
        <Field label={`Miktar (${unit})`} htmlFor="qty" hint="Sayımda rafta saydığınız toplam miktar.">
          <Input id="qty" name="qty" inputMode="decimal" required />
        </Field>
        <Field label="Tarih" htmlFor="date">
          <Input id="date" name="date" type="date" defaultValue={today} max={today} min={minDate} required />
        </Field>
        <Field label="Not" htmlFor="note" optional>
          <Input id="note" name="note" maxLength={200} />
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pendingText="Kaydediliyor…">Hareketi kaydet</SubmitButton></div>
    </form>
  );
}

export function UnitForm({ productId, unit }: { productId: string; unit: string }) {
  const [state, action] = useActionState(addUnit, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <input type="hidden" name="product_id" value={productId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label="Birim adı" htmlFor="u_name"><Input id="u_name" name="name" placeholder="Koli" required /></Field>
        <Field label={`Kaç ${unit}?`} htmlFor="u_factor"><Input id="u_factor" name="factor" inputMode="decimal" placeholder="24" required /></Field>
        <Field label="Koli barkodu" htmlFor="u_barcode" optional><Input id="u_barcode" name="barcode" inputMode="numeric" /></Field>
        <SubmitButton variant="secondary" pendingText="Ekleniyor…">Birim ekle</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function VatForm({ productId, today }: { productId: string; today: string }) {
  const [state, action] = useActionState(setProductVat, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="product_id" value={productId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Yeni KDV oranı (%)" htmlFor="rate">
          <Select id="rate" name="rate" defaultValue="" required>
            <option value="" disabled>Seçin</option>
            <option value="0">%0</option><option value="1">%1</option><option value="10">%10</option><option value="20">%20</option>
          </Select>
        </Field>
        <Field label="Geçerlilik başlangıcı" htmlFor="valid_from"><Input id="valid_from" name="valid_from" type="date" defaultValue={today} required /></Field>
        <SubmitButton variant="secondary" pendingText="Kaydediliyor…">Oranı kaydet</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function SupplierForm({ productId, unit, suppliers, current }: {
  productId: string; unit: string; suppliers: Array<{ id: string; name: string }>;
  current: { supplier_id: string; order_unit_name: string | null; order_unit_factor: string | null; min_order_qty: string | null } | null;
}) {
  const [state, action] = useActionState(setProductSupplier, undefined);
  if (suppliers.length === 0) return <p className="text-[14px] text-muted">Henüz tedarikçi yok. Alış faturası yüklendiğinde otomatik eklenir veya Ayarlar › Tedarikçiler’den ekleyebilirsiniz.</p>;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="product_id" value={productId} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Ana tedarikçi" htmlFor="supplier_id">
          <Select id="supplier_id" name="supplier_id" defaultValue={current?.supplier_id ?? ""} required>
            <option value="" disabled>Seçin</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Sipariş birimi" htmlFor="order_unit_name" optional><Input id="order_unit_name" name="order_unit_name" defaultValue={current?.order_unit_name ?? ""} placeholder="Koli" /></Field>
        <Field label={`Koli içi (${unit})`} htmlFor="order_unit_factor" optional><Input id="order_unit_factor" name="order_unit_factor" inputMode="decimal" defaultValue={current?.order_unit_factor ?? ""} placeholder="24" /></Field>
        <Field label={`Min. sipariş (${unit})`} htmlFor="min_order_qty" optional><Input id="min_order_qty" name="min_order_qty" inputMode="decimal" defaultValue={current?.min_order_qty ?? ""} /></Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton variant="secondary" pendingText="Kaydediliyor…">Kaydet</SubmitButton></div>
    </form>
  );
}

export function ProductForm({ product }: { product: { id: string; name: string; barcode: string | null; code: string | null; base_unit: string; shelf_life_days: number | null; category: string | null; is_active: boolean } }) {
  const [state, action] = useActionState(updateProduct, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="product_id" value={product.id} />
      <Field label="Ürün adı" htmlFor="name"><Input id="name" name="name" defaultValue={product.name} required /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Barkod" htmlFor="barcode" optional><Input id="barcode" name="barcode" defaultValue={product.barcode ?? ""} inputMode="numeric" /></Field>
        <Field label="Stok kodu" htmlFor="code" optional><Input id="code" name="code" defaultValue={product.code ?? ""} /></Field>
        <Field label="Temel birim" htmlFor="base_unit" hint="Stok hareketi olan ürünün birimi değiştirilemez.">
          <Select id="base_unit" name="base_unit" defaultValue={product.base_unit}><option value="adet">adet</option><option value="kg">kg</option><option value="lt">lt</option></Select>
        </Field>
        <Field label="Raf ömrü (gün)" htmlFor="shelf_life_days" optional hint="Sipariş önerisi raf ömrü içinde satılamayacak miktarı önermez.">
          <Input id="shelf_life_days" name="shelf_life_days" inputMode="numeric" defaultValue={product.shelf_life_days ?? ""} />
        </Field>
        <Field label="Kategori" htmlFor="category" optional><Input id="category" name="category" defaultValue={product.category ?? ""} /></Field>
      </div>
      <label className="flex items-center gap-2 text-[14px]">
        <input type="checkbox" name="is_active" value="1" defaultChecked={product.is_active} className="h-4 w-4" /> Ürün aktif (pasif ürünler listelerde ve sipariş önerisinde görünmez)
      </label>
      <FormMessage state={state} />
      <div><SubmitButton pendingText="Kaydediliyor…">Değişiklikleri kaydet</SubmitButton></div>
    </form>
  );
}
