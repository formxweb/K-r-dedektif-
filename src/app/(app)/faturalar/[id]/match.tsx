"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { createProductForItem, matchItem } from "@/server/invoices";
import { Field, Input, Select, buttonClass } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

interface Product { id: string; name: string; barcode: string | null; code: string | null; base_unit: string }

/** Ürün arama kutusu: yazdıkça sunucuda arar (ad, barkod, stok kodu). */
function ProductPicker({ name, initial }: { name: string; initial?: Product | null }) {
  const [q, setQ] = useState(initial?.name ?? "");
  const [items, setItems] = useState<Product[]>([]);
  const [chosen, setChosen] = useState<Product | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (chosen && q === chosen.name) return;
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setItems([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/urun-ara?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error();
        setItems(await r.json());
        setError(null);
        setOpen(true);
      } catch {
        setError("Arama yapılamadı. Bağlantınızı kontrol edin.");
      }
    }, 200);
  }, [q, chosen]);

  return (
    <div className="relative">
      <input type="hidden" name={name} value={chosen?.id ?? ""} />
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setChosen(null);
        }}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Ürün adı, barkod veya stok kodu"
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-surface shadow-[0_8px_24px_rgba(8,17,31,0.12)]">
          {items.map((p) => (
            <li key={p.id} role="option" aria-selected={chosen?.id === p.id}>
              <button type="button" className="flex w-full flex-col items-start px-3 py-2 text-left text-[14px] hover:bg-subtle"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setChosen(p); setQ(p.name); setOpen(false); }}>
                <span>{p.name}</span>
                <span className="num text-[12px] text-muted">{[p.barcode, p.code, p.base_unit].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && q.trim().length >= 2 && items.length === 0 && !error && <p className="mt-1 text-[12.5px] text-muted">Eşleşen ürün yok. Yeni ürün olarak ekleyebilirsiniz.</p>}
      {error && <p className="mt-1 text-[12.5px] text-neg">{error}</p>}
    </div>
  );
}

export function MatchForm({
  invoiceId, itemId, unitLabel, needsFactor, suggestion, current,
}: {
  invoiceId: string;
  itemId: string;
  unitLabel: string;
  needsFactor: boolean;
  suggestion?: Product | null;
  current?: Product | null;
}) {
  const [state, action] = useActionState(matchItem, undefined);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="unit_name" value={unitLabel} />
      <div className="grid gap-2 sm:grid-cols-[1fr_200px_auto] sm:items-end">
        <Field label="Ürün">
          <ProductPicker name="product_id" initial={current ?? suggestion ?? null} />
        </Field>
        <Field label={`1 ${unitLabel || "birim"} kaç temel birim?`} hint={needsFactor ? "Örn. 1 koli = 24 adet" : "Boş bırakılırsa otomatik"}>
          <Input name="factor" inputMode="decimal" placeholder={needsFactor ? "24" : "otomatik"} required={needsFactor} />
        </Field>
        <SubmitButton variant="primary" pendingText="Kaydediliyor…">{suggestion && !current ? "Öneriyi onayla" : "Eşleştir"}</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function NewProductForm({ invoiceId, itemId, name, barcode, unitLabel, unitIsPackage }: { invoiceId: string; itemId: string; name: string; barcode: string | null; unitLabel: string; unitIsPackage: boolean }) {
  const [state, action] = useActionState(createProductForItem, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => setOpen(true)}>Yeni ürün olarak ekle</button>;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line bg-subtle p-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="unit_name" value={unitLabel} />
      <div className="grid gap-2 sm:grid-cols-[1fr_120px_160px_160px]">
        <Field label="Ürün adı"><Input name="name" defaultValue={name} required /></Field>
        <Field label="Temel birim">
          <Select name="base_unit" defaultValue="adet"><option value="adet">adet</option><option value="kg">kg</option><option value="lt">lt</option></Select>
        </Field>
        <Field label="Barkod" optional><Input name="barcode" defaultValue={barcode ?? ""} inputMode="numeric" /></Field>
        <Field label={`1 ${unitLabel || "birim"} = ?`} hint={unitIsPackage ? "Zorunlu" : "Boşsa 1"}><Input name="factor" inputMode="decimal" required={unitIsPackage} /></Field>
      </div>
      <FormMessage state={state} />
      <div className="flex gap-2">
        <SubmitButton variant="primary" pendingText="Ekleniyor…">Ürünü ekle ve eşleştir</SubmitButton>
        <button type="button" className={buttonClass("ghost")} onClick={() => setOpen(false)}>Vazgeç</button>
      </div>
    </form>
  );
}
