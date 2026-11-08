import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/errors";
import { KIND_LABEL } from "@/lib/import/fields";
import { Badge, EmptyState, Page, PageHeader, Pagination, Panel, Section, Table, TableFrame, Td, Th } from "@/components/ui";
import { formatDateShort } from "@/lib/domain/format";
import { deleteProfile } from "@/server/imports";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Veri yükle" };

const STATUS: Record<string, { label: string; tone: "neutral" | "pos" | "warn" | "neg" | "info" }> = {
  staged: { label: "İşlenmeyi bekliyor", tone: "warn" },
  committed: { label: "İşlendi", tone: "pos" },
  reverted: { label: "Geri alındı", tone: "neutral" },
  cancelled: { label: "İptal edildi", tone: "neutral" },
};

export default async function DataPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const page = Math.max(1, Number((await searchParams).s ?? 1) || 1);
  const size = 20;
  const jobsRes = await supabase
    .from("import_jobs")
    .select("id, kind, file_name, status, row_count, ok_count, warning_count, error_count, created_at, committed_at, params", { count: "exact" })
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  const jobs = must(jobsRes);
  const profiles = must(await supabase.from("import_profiles").select("id, name, kind, source_system, updated_at").eq("organization_id", org.id).order("updated_at", { ascending: false }));

  return (
    <Page>
      <PageHeader title="Veri yükleme" description="POS programınızın dışa aktardığı dosyaları ve alış faturalarını buradan yükleyin. Her yükleme önizlenir, onayınızla kaydedilir ve geri alınabilir." />
      <Panel>
        <UploadForm />
      </Panel>

      <Section title="Aktarım geçmişi" description="Hangi dosyanın ne zaman, kaç satırla işlendiği. Satıra tıklayarak ayrıntıyı ve geri alma seçeneğini görün.">
        <TableFrame footer={<Pagination page={page} pageSize={size} total={jobsRes.count ?? 0} hrefFor={(p) => `/veri?s=${p}`} />}>
          {jobs.length === 0 ? (
            <EmptyState title="Henüz dosya yüklenmedi">
              İlk olarak POS programınızdan <strong>ürün/stok listesini</strong> yükleyin. Açılış stoğu ve maliyetler buradan oluşur. Ardından satış raporunu ve alış faturalarını ekleyin.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Dosya</Th>
                  <Th className="hidden sm:table-cell">Tür</Th>
                  <Th className="hidden md:table-cell">Yüklenme</Th>
                  <Th align="right" className="hidden md:table-cell">Satır</Th>
                  <Th>Durum</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="hover:bg-subtle">
                    <Td>
                      <Link href={j.kind === "purchase_invoice_xml" ? `/veri/${j.id}` : `/veri/${j.id}`} className="font-medium text-accent hover:underline">
                        {j.file_name}
                      </Link>
                      <div className="text-[12.5px] text-muted sm:hidden">{KIND_LABEL[j.kind as keyof typeof KIND_LABEL]}</div>
                    </Td>
                    <Td className="hidden text-muted sm:table-cell">{KIND_LABEL[j.kind as keyof typeof KIND_LABEL]}</Td>
                    <Td className="hidden md:table-cell num text-muted">{formatDateShort(j.created_at)}</Td>
                    <Td align="right" className="hidden md:table-cell num">
                      {j.row_count}
                      {j.error_count > 0 && <span className="ml-1 text-neg">({j.error_count} sorunlu)</span>}
                    </Td>
                    <Td><Badge tone={STATUS[j.status]?.tone}>{STATUS[j.status]?.label ?? j.status}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableFrame>
      </Section>

      <Section title="Aktarım profilleri" description="Bir dosya türünün sütun eşleştirmesi bir kez kaydedilir; aynı başlıklı dosyalarda otomatik uygulanır.">
        <TableFrame>
          {profiles.length === 0 ? (
            <EmptyState title="Kayıtlı profil yok">İlk tablo dosyasını eşleştirirken “profili kaydet” seçeneği açık kalırsa burada görünür.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Profil</Th><Th className="hidden sm:table-cell">Tür</Th><Th className="hidden sm:table-cell">Güncelleme</Th><Th align="right"> </Th></tr></thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id}>
                    <Td><span className="font-medium">{p.name}</span>{p.source_system && <span className="ml-2 text-[12.5px] text-muted">{p.source_system}</span>}</Td>
                    <Td className="hidden text-muted sm:table-cell">{KIND_LABEL[p.kind as keyof typeof KIND_LABEL]}</Td>
                    <Td className="hidden num text-muted sm:table-cell">{formatDateShort(p.updated_at)}</Td>
                    <Td align="right">
                      <form action={deleteProfile}>
                        <input type="hidden" name="profile_id" value={p.id} />
                        <button className="text-[13px] text-neg hover:underline">Profili sil</button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableFrame>
      </Section>
    </Page>
  );
}
