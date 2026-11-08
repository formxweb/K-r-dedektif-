# KârDedektifi MVP — Şema ve Yapı Planı (taslak, onay bekliyor)

Durum: 8 Kas 2026. Repo boş, `/samples` yok. Bu plan Fenix dosya formatından bağımsız kısımları kapsar.
Aktarım profillerinin alan listesi, örnek dosyalar incelendikten sonra netleşecek.

---

## 1. Temel teknik kararlar

| Konu | Karar | Neden |
|---|---|---|
| Hesap motoru | Saf TypeScript + decimal.js (`src/lib/domain`), sadece sunucuda çalışır | Vitest ile elle hesaplanmış senaryolarla test edilebilir |
| Yazma işlemleri | Tek bir Postgres RPC çağrısı (plpgsql), tek transaction | supabase-js çoklu çağrıda transaction sağlamaz; aktarım ve geri alma atomik olmalı |
| Yarış durumu | Her işletmede `ledger_version`; RPC beklenen sürümü kontrol eder + `pg_advisory_xact_lock` | Önizleme ile kayıt arasında başka aktarım girerse işlem reddedilir, kullanıcı yeniden önizler |
| numeric okuma | Finansal alanlar her zaman `::text` olarak okunur, `Decimal`'a çevrilir | PostgREST numeric'i JSON number olarak döner, JS'de hassasiyet kaybolur |
| İstemci yetkisi | Finansal tablolarda istemci sadece SELECT (RLS). INSERT/UPDATE sadece `security definer` RPC'lerle | Kurallar (mükerrer, maliyet zinciri) atlanamaz |
| service_role anahtarı | MVP'de kullanılmaz. Tüm işlemler kullanıcının oturumuyla, RLS altında | Sızarsa her şeyi açan anahtar hiç sunucuda bile durmaz |
| Tekrarlayan gider | Cron yok; Giderler ekranı açılınca o ayın bekleyen kayıtları RPC ile oluşturulur, kullanıcı onaylar | Ek altyapı ve anahtar gerektirmez |
| Dosyalar | Supabase Storage, özel bucket, yol `org_id/...`, Storage RLS ile | Kaynak dosya her rakam için izlenebilir kalır |
| Excel | SheetJS (`xlsx`) — .xls da okuyan tek ciddi seçenek. npm'deki 0.18.5 sürümünde bilinen açıklar var; güncel sürüm cdn.sheetjs.com'dan alınmalı (şu an bu ortamda o host kapalı, adım 5'te açılması gerekecek) | |
| Kodlama | Windows-1254 / UTF-8 tespiti, `TextDecoder` | Fenix CSV'leri büyük ihtimalle 1254 (örnekle doğrulanacak) |
| RLS testleri | Yerel Postgres 16 + Supabase `auth` şemasının küçük taklidi (`auth.uid()`, roller) üzerinde Vitest | Docker imajı indirmeye bağımlı olmadan CI'da da çalışır |

---

## 2. Veritabanı şeması

Ortak: her tabloda `id uuid`, `organization_id`, `created_at`, `created_by`. Para `numeric(14,4)`, miktar `numeric(14,3)`, oran `numeric(7,4)`.
İstisna: `organizations` (kendi id'si) ve `profiles` (kullanıcıya ait) — RLS bunlarda üyelik/kendi kaydı ile.
RLS: `private.is_member(organization_id)` (security definer) — her tabloda select/insert/update/delete politikası.

### Hesap
- `organizations` — ad, `vat_regime` (`standard`/`simplified`), `margin_alert_threshold_pts` (vars. 5), `dead_stock_days` (vars. 60), `price_rounding_step` (vars. 0,50 ₺), `ledger_version`
- `profiles` — kullanıcı adı
- `organization_members` — rol: owner / admin / member

### Ürün
- `categories`
- `products` — ad, barkod (işletme içinde tekil), `base_unit` (adet/kg/lt), terazi ürünü mü, raf ömrü (gün), aktif mi
- `product_units` — alış birimi → temel birim katsayısı (1 koli = 24 adet), birim barkodu, tedarikçi (opsiyonel)
- `tax_rates` — ürün × KDV oranı × geçerlilik aralığı (`valid_from`, `valid_to`); çakışma `exclude` kısıtıyla engellenir
- `product_price_history` — satış fiyatı (KDV dahil/hariç bilgisiyle), geçerlilik tarihi, kaynak aktarım
- `product_suppliers` *(ek)* — ana tedarikçi, minimum sipariş miktarı, sipariş birimi. Sipariş listesini tedarikçiye göre gruplamak için gerekli.

### Tedarikçi
- `suppliers` — ad, VKN, teslim süresi, sipariş aralığı, minimum sipariş tutarı
- `supplier_product_aliases` — tedarikçi ürün kodu/adı → ürün + hangi birim (koli mi adet mi). Onaylayan, tarih.
- `supplier_rebates` — dönem sonu / ciro primi, tutar, yansıdığı ay

### Alış
- `purchase_invoices` — tedarikçi, fatura no, ETTN, tarih, belgedeki toplamlar + satırlardan hesaplanan toplamlar, fark uyarısı, durum (taslak / eşleştiriliyor / kesinleşti / geri alındı), aktarım
- `purchase_items` — ham ad/kod/barkod, miktar, ham birim, eşleşen ürün ve birim, temel birim miktarı, birim fiyat, iskonto, KDV hariç net, KDV oranı/tutarı, temel birim başına net maliyet, eşleşme yöntemi (barkod / kayıtlı eşleşme / elle)

### Satış
- `sales_period_summaries` — ürün, dönem başı–sonu, adet, dosyadaki tutar, KDV hariç net, KDV oranı, **satış anındaki birim maliyet ve toplam maliyet**
- `sale_items` — fiş bazlı veri varsa: fiş no, zaman, ürün, adet, tutar, net, **birim maliyet, toplam maliyet**

### Stok
- `inventory_movements` — ürün, zaman + sıra no, tür (açılış, alış, satış, müşteri iadesi, tedarikçiye iade, fire, bozulma, sayım farkı, **maliyet düzeltmesi**), işaretli miktar, birim maliyet, toplam maliyet, hareket sonrası stok ve ortalama maliyet, kaynak kayıt, aktarım, `voided_at`

### Gider
- `expense_categories` — 13 kategori, işletme oluşturulurken eklenir (sahte veri değil, referans listesi)
- `expenses` — kategori, ay, tarih, KDV hariç tutar, KDV, durum (bekliyor / onaylı), tekrarlayan kaynağı
- `recurring_expenses` — kategori, tutar, ayın günü, başlangıç/bitiş ayı

### Aktarım
- `import_profiles` — kaynak sistem, tür (ürün listesi / satış özeti / fiş satışı / alış), başlık imzası (otomatik tanıma), başlık satırı, sütun eşleştirmesi, ondalık/binlik ayracı, tarih biçimi, kodlama, **her fiyat alanı için KDV dahil mi**
- `import_jobs` — dosya adı, depolama yolu, SHA-256, tür, dönem, satır sayıları, durum (yüklendi / eşleştirildi / önizlendi / kaydedildi / geri alındı / hata), kaydeden, geri alan, geri alma nedeni
- `import_rows` — satır no, ham veri, ayrıştırılmış veri, durum (tamam / uyarı / hata / mükerrer / onay bekliyor), mesajlar, oluşturduğu kayıt

### Analiz
- `forecast_runs` — parametreler, veri sıklığı, algoritma sürümü, durum (öneri / **sipariş verildi**)
- `forecast_items` — haftalık talep, trend, stok, yoldaki, güvenlik stoğu, önerilen miktar, koli, aralık, güven, gerekçe, girdiler (izlenebilirlik için)
- `period_markers` — Ramazan, bayram vb.: tarih aralığı, çarpan, kapsam (tümü / kategori)
- `alerts` — tür (marj düşüşü, fatura toplam farkı, sayım farkı, maliyet revizyonu, bilinmeyen maliyet), ürün, veri, durum

### Bütünlük (bölüm 11 için ek tablolar)
- `accounting_periods` — ay, açık/kapalı, kapatan, tarih
- `cost_revisions` — hangi işlem tetikledi, hangi hareket, eski/yeni birim maliyet, fark, ay
- `audit_log` — kim, ne, hangi kayıt, önce/sonra (jsonb). Finansal tablolarda trigger ile otomatik.

---

## 3. Hesap kuralları — açık kalan noktalara önerilen çözümler

**Hareketli ağırlıklı ortalama**
- Alış: `yeni_ort = (stok × ort + miktar × birim_maliyet) / (stok + miktar)`
- Satış: `SMM = miktar × satış anındaki ort`; ortalama değişmez.
- Stok ≤ 0 iken alış gelirse: yeni ortalama = alış birim maliyeti (negatif stokla saçma ortalama oluşmasın).
- Hiç maliyet bilgisi yokken satış: maliyet uydurulmaz → "maliyet bilinmiyor" işareti, uyarı, o satır marj hesabından çıkarılıp ayrıca gösterilir.

**Dönemlik satış özeti** (ör. 1–7 Kasım toplamı): dönemin son anında tek satış hareketi olarak işlenir.
Sonuç: maliyet = (dönem başı stok değeri + dönem içi alışlar) / (dönem başı stok + dönem içi alış miktarı) → dönem içi ağırlıklı ortalama.
Aynı ürün ve tarih aralığı için çakışan satış aktarımı engellenir (özet + fiş bazlı veri üst üste binemez).

**Geçmiş tarihli kayıt**
1. Sistem ilgili ürünlerin maliyet zincirini o tarihten itibaren yeniden hesaplar ve **önizleme** gösterir: hangi satışların maliyeti değişiyor, hangi ayın kârı ne kadar değişiyor.
2. Kullanıcı onaylar → tek transaction. Eski değerler `cost_revisions` + `audit_log`'a yazılır, "Ekim kârı −412,30 ₺ değişti, nedeni: 3 Ekim tarihli fatura #A123" uyarısı oluşur. Sessiz değişiklik yok.
3. **Kapalı aydaki** kayıtlar asla değişmez. Fark, ilk açık aya "geçmiş dönem maliyet düzeltmesi" hareketi olarak yazılır; kâr tablosunda (sıfır değilse) ayrı satır olarak görünür.

**Geri alma** (`revert_import_job` RPC): advisory lock → aktarımın kayıtları silinmez, `voided`/`reversed` işaretlenir → zincir yeniden hesaplanır (yukarıdaki kurallarla, önizleme + onay) → audit. Mükerrer kontrolü sadece geçerli (iptal edilmemiş) kayıtlara bakan kısmi unique index'lerle yapılır; böylece geri alınan dosya tekrar yüklendiğinde mükerrer kayıt oluşmaz.

**Mükerrer kontrolü üç katmanlı**: (1) dosya SHA-256, (2) tedarikçi + fatura no (+ ETTN), (3) satışta ürün + tarih aralığı çakışması. Hash tek başına yetmez: Excel'de açıp kaydetmek hash'i değiştirir.

**Marj uyarısı**: kâr tablosu ortalama maliyetle hesaplanır; fiyat kararı ise **yeni alış fiyatıyla** (yerine koyma maliyeti) verilir, çünkü bir sonraki mal o fiyattan gelecek. Önerilen raf fiyatı = yeni maliyet / (1 − eski marj) × (1 + KDV), ayarlanan adıma yukarı yuvarlanır. Uyarı, hangi tarihli Fenix fiyat listesine göre hesaplandığını yazar.

---

## 4. Klasör yapısı

```
src/
  app/
    (auth)/giris, kayit, isletme-olustur
    (app)/genel-bakis, veri, urunler, urunler/[id], faturalar, faturalar/[id],
          giderler, siparis-onerileri, ayarlar
  lib/
    domain/      money, vat, units, costing, pnl, forecast, margin   ← saf, %100 test
    import/      excel, csv, ubl-tr, pdf, profiles, mapping, dedupe
    db/          sunucu Supabase istemcisi, tipli sorgular (numeric→text→Decimal)
    format/      TL ve tarih biçimleri (tr-TR)
  server/        server actions (her biri zod ile doğrulanır)
  components/
supabase/
  migrations/    şema, RLS, RPC'ler
tests/
  domain/        elle hesaplanmış senaryolar
  db/            RLS izolasyon testleri (yerel Postgres)
docs/            PLAN.md, fenix-format.md (örnek inceleme raporu)
samples/         gerçek Fenix dosyaları — git'e GİRMEZ (.gitignore)
```
