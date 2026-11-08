import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { dec, sum } from "@/lib/domain/decimal";
import { addMonths, istToday, monthStart } from "@/lib/domain/dates";
import { formatMonth } from "@/lib/domain/format";
import { Badge, Callout, EmptyState, Money, Page, PageHeader, Panel, Pct, Section, Table, TableFrame, Td, Th, buttonClass } from "@/components/ui";
import { deleteExpense, deleteRebate, setExpenseStatus, stopRecurring } from "@/server/expenses";
import { ExpenseForm, RebateForm, RecurringForm } from "./forms";

export const metadata: Metadata = { title: "Giderler" };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ ay?: string; hata?: string }> }) {
  const sp = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const current = monthStart(istToday());
  const m = sp.ay && /^\d{4}-\d{2}$/.test(sp.ay) && `${sp.ay}-01` <= current ? `${sp.ay}-01` : current;
  const ym = m.slice(0, 7);
  const closed = org.closed_through !== null && m <= org.closed_through;

  // Tekrarlayan giderlerin bu aya ait kayıtları (onay bekler)
  if (!closed) await supabase.rpc("generate_recurring_expenses", { p_org: org.id, p_month: m });

  const [cats, expenses, comparison, recurring, rebates, suppliers] = await Promise.all([
    supabase.from("expense_categories").select("id, name, sort_order").eq("organization_id", org.id).order("sort_order"),
    supabase.from("expenses").select("id, category_id, amount::text, vat_amount::text, description, status, recurring_expense_id, expense_categories(name)").eq("organization_id", org.id).eq("month", m).order("created_at"),
    supabase.rpc("expense_comparison", { p_org: org.id, p_month: m }),
    supabase.from("recurring_expenses").select("id, description, amount::text, start_month, is_active, expense_categories(name)").eq("organization_id", org.id).eq("is_active", true).order("created_at"),
    supabase.from("supplier_rebates").select("id, amount::text, description, suppliers(name)").eq("organization_id", org.id).eq("month", m),
    supabase.from("suppliers").select("id, name").eq("organization_id", org.id).eq("is_active", true).order("name"),
  ]);
  const categories = must(cats);
  const list = must(expenses);
  const cmp = (must(comparison) as Array<{ category_id: string; name: string; sort_order: number; this_month: string; prev_month: string; last_year: string }>).sort((a, b) => a.sort_order - b.sort_order);
  const rec = must(recurring);
  const reb = must(rebates);
  const pending = list.filter((e) => e.status === "pending");
  const approved = list.filter((e) => e.status === "approved");
  const totals = { cur: sum(cmp.map((c) => c.this_month)), prev: sum(cmp.map((c) => c.prev_month)), ly: sum(cmp.map((c) => c.last_year)) };
  const months = Array.from({ length: 18 }, (_, i) => addMonths(current, -i));

  return (
    <Page>
      <PageHeader
        title="Giderler"
        description="Aylık işletme giderleri KDV hariç girilir ve kâr tablosuna o ayın gideri olarak yazılır."
        actions={
          <form className="flex items-center gap-2">
            <Link className={buttonClass("secondary", "px-2.5")} href={`/giderler?ay=${addMonths(m, -1).slice(0, 7)}`} aria-label="Önceki ay">‹</Link>
            <label htmlFor="ay" className="sr-only">Ay</label>
            <select id="ay" name="ay" defaultValue={ym} className="min-h-10 rounded-md border border-line-strong bg-surface px-3 text-[14px]">
              {months.map((x) => <option key={x} value={x.slice(0, 7)}>{formatMonth(x)}</option>)}
            </select>
            <button className={buttonClass("secondary")}>Git</button>
            {m < current && <Link className={buttonClass("secondary", "px-2.5")} href={`/giderler?ay=${addMonths(m, 1).slice(0, 7)}`} aria-label="Sonraki ay">›</Link>}
          </form>
        }
      />
      {sp.hata && <div className="mb-4"><Callout tone="neg" title="İşlem yapılamadı">{sp.hata}</Callout></div>}
      {closed && <div className="mb-4"><Callout tone="info" title={`${formatMonth(m)} kapalı`}>Kapalı dönemin giderleri değiştirilemez. Değişiklik için Ayarlar › Dönem kapatma’dan ayı yeniden açın.</Callout></div>}

      {pending.length > 0 && (
        <Section title="Onay bekleyen tekrarlayan giderler" description="Her ay otomatik oluşur. Tutar değiştiyse düzeltip onaylayın.">
          <div className="flex flex-col gap-2">
            {pending.map((e) => (
              <Panel key={e.id} className="border-warn/40">
                <form action={setExpenseStatus} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="ym" value={ym} />
                  <div><p className="font-medium">{e.description}</p><p className="text-[13px] text-muted">{(e.expense_categories as unknown as { name: string })?.name}</p></div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={`amt-${e.id}`} className="sr-only">Tutar</label>
                    <input id={`amt-${e.id}`} name="amount" defaultValue={e.amount.replace(".", ",").replace(/,?0+$/, "")} inputMode="decimal" className="num min-h-10 w-32 rounded-md border border-line-strong px-3 text-right text-[15px]" />
                    <button name="status" value="approved" className={buttonClass("primary")}>Onayla</button>
                    <button name="status" value="skipped" className={buttonClass("secondary")}>Bu ay yok</button>
                  </div>
                </form>
              </Panel>
            ))}
          </div>
        </Section>
      )}

      <Section title={`${formatMonth(m)} giderleri`} description={approved.length ? undefined : "Bu ay için onaylı gider yok."}>
        <TableFrame footer={approved.length ? <div className="flex justify-between text-[14px] font-semibold"><span>Toplam</span><Money value={sum(approved.map((e) => e.amount)).toString()} /></div> : undefined}>
          {approved.length === 0 ? (
            <EmptyState title="Gider girilmedi">Kira, personel, SGK, elektrik gibi giderleri aşağıdaki formdan ekleyin. Düzenli giderleri bir kez “tekrarlayan” olarak tanımlayın.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Kategori</Th><Th className="hidden sm:table-cell">Açıklama</Th><Th align="right">Tutar</Th><Th align="right"> </Th></tr></thead>
              <tbody>
                {approved.map((e) => (
                  <tr key={e.id}>
                    <Td>{(e.expense_categories as unknown as { name: string })?.name}{e.recurring_expense_id && <span className="ml-2"><Badge>tekrarlayan</Badge></span>}<div className="text-[12.5px] text-muted sm:hidden">{e.description}</div></Td>
                    <Td className="hidden text-muted sm:table-cell">{e.description ?? "—"}</Td>
                    <Td align="right"><Money value={e.amount} /></Td>
                    <Td align="right">{!closed && <form action={deleteExpense}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="ym" value={ym} /><button className="text-[13px] text-neg hover:underline">Sil</button></form>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableFrame>
        {!closed && <div className="mt-3"><Panel><ExpenseForm categories={categories} ym={ym} /></Panel></div>}
      </Section>

      <Section title="Karşılaştırma" description="Onaylı giderler: bu ay, önceki ay ve geçen yılın aynı ayı.">
        <TableFrame>
          <Table>
            <thead><tr><Th>Kategori</Th><Th align="right">{formatMonth(m)}</Th><Th align="right" className="hidden sm:table-cell">{formatMonth(addMonths(m, -1))}</Th><Th align="right" className="hidden sm:table-cell">{formatMonth(addMonths(m, -12))}</Th><Th align="right">Önceki aya göre</Th></tr></thead>
            <tbody>
              {cmp.filter((c) => !dec(c.this_month).isZero() || !dec(c.prev_month).isZero() || !dec(c.last_year).isZero()).map((c) => {
                const ch = dec(c.prev_month).gt(0) ? dec(c.this_month).div(c.prev_month).minus(1).times(100) : null;
                return (
                  <tr key={c.category_id}>
                    <Td>{c.name}</Td>
                    <Td align="right"><Money value={c.this_month} /></Td>
                    <Td align="right" className="hidden sm:table-cell text-muted"><Money value={c.prev_month} /></Td>
                    <Td align="right" className="hidden sm:table-cell text-muted"><Money value={c.last_year} /></Td>
                    <Td align="right">{ch ? <Pct value={ch} signed className={ch.gt(0) ? "text-neg" : "text-pos"} /> : "—"}</Td>
                  </tr>
                );
              })}
              <tr className="font-semibold">
                <Td>Toplam</Td><Td align="right"><Money value={totals.cur.toString()} /></Td>
                <Td align="right" className="hidden sm:table-cell"><Money value={totals.prev.toString()} /></Td>
                <Td align="right" className="hidden sm:table-cell"><Money value={totals.ly.toString()} /></Td>
                <Td align="right">{totals.prev.gt(0) ? <Pct value={totals.cur.div(totals.prev).minus(1).times(100)} signed /> : "—"}</Td>
              </tr>
            </tbody>
          </Table>
        </TableFrame>
      </Section>

      <Section title="Tekrarlayan giderler" description="Her ay otomatik oluşur, onayınızla kâr tablosuna girer.">
        <TableFrame>
          {rec.length === 0 ? <EmptyState title="Tekrarlayan gider yok">Kira, maaş, internet gibi her ay aynı olan giderleri bir kez tanımlayın.</EmptyState> : (
            <Table>
              <thead><tr><Th>Açıklama</Th><Th className="hidden sm:table-cell">Kategori</Th><Th align="right">Aylık</Th><Th align="right"> </Th></tr></thead>
              <tbody>{rec.map((r) => (
                <tr key={r.id}>
                  <Td>{r.description}<div className="text-[12.5px] text-muted">{formatMonth(r.start_month)} itibarıyla</div></Td>
                  <Td className="hidden sm:table-cell text-muted">{(r.expense_categories as unknown as { name: string })?.name}</Td>
                  <Td align="right"><Money value={r.amount} /></Td>
                  <Td align="right"><form action={stopRecurring}><input type="hidden" name="id" value={r.id} /><button className="text-[13px] text-neg hover:underline">Durdur</button></form></Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </TableFrame>
        <div className="mt-3"><Panel><RecurringForm categories={categories} ym={ym} /></Panel></div>
      </Section>

      <Section title="Tedarikçi primleri" description="Dönem sonu ve ciro primleri ilgili ayın kârına ayrı satır olarak eklenir.">
        <TableFrame>
          {reb.length === 0 ? <EmptyState title="Bu ay prim yok" /> : (
            <Table>
              <thead><tr><Th>Tedarikçi</Th><Th className="hidden sm:table-cell">Açıklama</Th><Th align="right">Tutar</Th><Th align="right"> </Th></tr></thead>
              <tbody>{reb.map((r) => (
                <tr key={r.id}>
                  <Td>{(r.suppliers as unknown as { name: string })?.name}</Td>
                  <Td className="hidden sm:table-cell text-muted">{r.description ?? "—"}</Td>
                  <Td align="right"><Money value={r.amount} /></Td>
                  <Td align="right">{!closed && <form action={deleteRebate}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="ym" value={ym} /><button className="text-[13px] text-neg hover:underline">Sil</button></form>}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </TableFrame>
        {!closed && <div className="mt-3"><Panel><RebateForm suppliers={must(suppliers)} ym={ym} /></Panel></div>}
      </Section>
    </Page>
  );
}
