# KârDedektifi

Marketin POS programının üzerine oturan kârlılık ve satın alma karar aracı. POS'un yerine geçmez (satış ekranı, fiş, kasa, veresiye yok). Üç soruya cevap verir:

1. Bu ay giderler düşüldükten sonra gerçekte ne kadar kazandım?
2. Hangi ürünler kazandırıyor, hangileri kaybettiriyor?
3. Gelecek ay neyi, ne kadar almalıyım?

## Teknik yapı

| Katman | Seçim |
|---|---|
| Uygulama | Next.js 16 (App Router), TypeScript strict, Tailwind v4 |
| Veri | Supabase (PostgreSQL, Auth, Storage, RLS) |
| Para/miktar | Veritabanında `numeric(14,4)` / `numeric(14,3)`, uygulamada `decimal.js`. PostgREST'ten okurken `::text`. |
| Maliyet zinciri | plpgsql (`private.recompute_chain`) — hareketli ağırlıklı ortalama, tek transaction |
| Dosya okuma | SheetJS 0.20.3 (`vendor/`, .xls/.xlsx), papaparse (CSV, UTF-8 / Windows-1254), fast-xml-parser (e-Fatura UBL-TR) |
| Grafik | Recharts |
| Test | Vitest — alan mantığı + yerel Postgres üzerinde veritabanı testleri |

```
src/
  app/(auth)        giriş, kayıt, şifre sıfırlama
  app/(app)         genel-bakis, veri, urunler, faturalar, giderler, siparis-onerileri, uyarilar, ayarlar
  lib/domain        saf hesaplar: KDV, birim, fatura, kâr tablosu, marj, sipariş önerisi (decimal.js)
  lib/import        dosya okuma, başlık tespiti, sütun eşleştirme, satır dönüşümü, UBL-TR
  lib/data          sunucu tarafı veri erişimi
  server/           server action'lar (zod doğrulamalı)
supabase/migrations şema, RLS, RPC'ler, raporlar
tests/domain        elle hesaplanmış senaryolar
tests/import        dosya okuma ve dönüşüm
tests/db            maliyet zinciri, kapalı dönem, geri alma, mükerrer, RLS izolasyonu
```

## Kurulum

```bash
npm install
cp .env.example .env.local   # Supabase URL ve publishable key
npm run dev
```

Migration'lar `supabase/migrations/` altında, sırayla uygulanır.

### Canlı ortam

- Uygulama: https://kardedektifi.vercel.app (Vercel, fra1)
- Veritabanı: Supabase `kardedektifi` (eu-central-1)
- Auth: Site URL ve dönüş adresleri (`/auth/callback`) ayarlı, e-posta doğrulama açık, en az 8 karakter şifre.
- Not: Supabase'in yerleşik e-posta servisi saatlik düşük limitlidir; birden fazla kullanıcıya açılmadan önce özel SMTP (ör. Resend) tanımlanmalı.

## Testler

```bash
npm test            # alan mantığı + dosya okuma (56 test)
npm run test:db     # veritabanı (26 test) — yerel Postgres 16 gerekir
```

Veritabanı testleri `tests/db/reset-db.sh` ile boş bir veritabanına Supabase taklidini (`auth.uid()`, roller) ve tüm migration'ları kurar. Bağlantı: `KD_TEST_ADMIN_URL` (varsayılan `postgresql://postgres@127.0.0.1:54329/postgres`).

## Temel kurallar (koddaki karşılıkları)

- **Sahte veri yok.** Veri yoksa boş durum gösterilir.
- **Hesaplar sunucuda.** Maliyet zinciri veritabanında, kâr tablosu ve sipariş önerisi sunucuda (decimal.js).
- **Defter tabloları istemciden salt okunur.** Stok hareketi, satış, fatura durumu sadece `security definer` RPC'lerle değişir.
- **Mükerrer engeli üç katmanlı:** dosya hash'i, tedarikçi + fatura no (+ETTN), ürün + tarih aralığı çakışması.
- **Her aktarım önizlenir ve geri alınabilir.** Önizleme aynı kodu çalıştırıp geri sarar; geçmiş aylara etkisi önceden gösterilir.
- **Geçmiş kâr sessizce değişmez.** Açık aylarda değişen her satış maliyeti `cost_revisions`'a yazılır ve uyarı oluşur. Kapalı aylar donuktur; fark ilk açık aya "geçmiş dönem maliyet düzeltmesi" olarak yazılır.
- **Audit log:** kritik tablolardaki her değişiklik önce/sonra ile `audit_log`'da.

## Bilinen sınırlar (MVP)

- Sadece gerçek usul KDV.
- POS dosya formatı örnekle doğrulanmadı; sütun eşleştirme genel ve profil olarak kaydedilir.
- PDF alış faturası okuma yok (örnek PDF'lerle eklenecek). Taranmış fatura (OCR) kapsam dışı.
- İade faturası ve dövizli fatura desteklenmiyor (açıkça reddedilir).
