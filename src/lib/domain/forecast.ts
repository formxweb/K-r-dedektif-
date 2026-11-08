import { D, dec, qty, sum, ZERO, type Dec, type DecInput } from "./decimal";
import { addDays, daysBetween } from "./dates";
import { formatQty, formatSignedPct } from "./format";

export const FORECAST_VERSION = "holt-v1";

/** Holt yöntemi katsayıları: yakın haftalar daha ağır (α), eğilim yumuşatma (β) */
export const ALPHA = new D("0.4");
export const BETA = new D("0.2");
/** Güvenlik stoğu için hizmet düzeyi katsayısı (≈ %95) */
export const Z_SERVICE = new D("1.65");

export type Confidence = "insufficient" | "low" | "medium" | "high";

export interface SalesRecord {
  /** dahil, YYYY-MM-DD */
  start: string;
  end: string;
  qty: DecInput;
}

export interface PeriodMarker {
  start: string;
  end: string;
  multiplier: DecInput;
}

export interface ForecastInput {
  /** İşletmenin en son satış verisi tarihi */
  dataEnd: string;
  /** İşletme genelinde satış verisinin kapsadığı tarih aralıkları (boşluklu olabilir) */
  coverage: Array<{ start: string; end: string }>;
  /** Ürünün ilk hareket tarihi (varsa) */
  productStart: string | null;
  records: SalesRecord[];
  stock: DecInput;
  onOrder: DecInput;
  leadTimeDays: number;
  orderIntervalDays: number;
  packSize: DecInput | null;
  packName: string | null;
  baseUnit: string;
  minOrderQty: DecInput | null;
  shelfLifeDays: number | null;
  markers: PeriodMarker[];
  /** Siparişin kapsayacağı dönem bu tarihten sonra başlar */
  today: string;
  maxWeeks?: number;
}

export interface ForecastResult {
  confidence: Confidence;
  granularity: "weekly" | "coarse" | "none";
  weeksOfData: number;
  observations: number;
  avgWeekly: Dec | null;
  weeklyDemand: Dec | null;
  trendPct: Dec | null;
  sigmaWeekly: Dec | null;
  safetyStock: Dec;
  coverageDemand: Dec;
  suggestedQty: Dec;
  suggestedUnits: Dec;
  rangeLowUnits: Dec;
  rangeHighUnits: Dec;
  packSize: Dec;
  daysOfCover: Dec | null;
  reason: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

/** Holt doğrusal üstel düzleştirme. Seri eskiden yeniye sıralı olmalı. Bir sonraki dönem tahminini döner. */
export function holt(series: DecInput[], alpha: DecInput = ALPHA, beta: DecInput = BETA): { level: Dec; trend: Dec; forecast: Dec } {
  const x = series.map((v) => dec(v));
  if (x.length === 0) return { level: ZERO, trend: ZERO, forecast: ZERO };
  const a = dec(alpha);
  const b = dec(beta);
  let level = x[0]!;
  let trend = x.length > 1 ? x[1]!.minus(x[0]!) : ZERO;
  for (let t = 1; t < x.length; t++) {
    const prevLevel = level;
    level = a.times(x[t]!).plus(new D(1).minus(a).times(prevLevel.plus(trend)));
    trend = b.times(level.minus(prevLevel)).plus(new D(1).minus(b).times(trend));
  }
  return { level, trend, forecast: level.plus(trend) };
}

export function mean(values: Dec[]): Dec {
  if (values.length === 0) return ZERO;
  return sum(values).div(values.length);
}

/** Örneklem standart sapması */
export function stdDev(values: Dec[]): Dec {
  if (values.length < 2) return ZERO;
  const m = mean(values);
  const ss = sum(values.map((v) => v.minus(m).pow(2)));
  return ss.div(values.length - 1).sqrt();
}

function multiplierOn(day: string, markers: PeriodMarker[]): Dec {
  let m = new D(1);
  for (const mk of markers) {
    if (day >= mk.start && day <= mk.end) {
      const v = dec(mk.multiplier);
      if (v.gt(m) || m.eq(1)) m = v;
    }
  }
  return m;
}

/** Bir tarih aralığındaki ortalama dönem çarpanı */
export function avgMultiplier(start: string, days: number, markers: PeriodMarker[]): Dec {
  if (markers.length === 0 || days <= 0) return new D(1);
  let s = ZERO;
  for (let i = 0; i < days; i++) s = s.plus(multiplierOn(addDays(start, i), markers));
  return s.div(days);
}

function coveredDays(start: string, end: string, coverage: Array<{ start: string; end: string }>): number {
  let n = 0;
  for (let dday = start; dday <= end; dday = addDays(dday, 1)) {
    if (coverage.some((c) => dday >= c.start && dday <= c.end)) n++;
  }
  return n;
}

function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s > e ? 0 : daysBetween(s, e) + 1;
}

export interface WeekBucket {
  start: string;
  end: string;
  qty: Dec;
  adjusted: Dec;
}

/**
 * Satış kayıtlarını dataEnd'de biten 7 günlük kovalara böler. Kayıtlar günlere eşit dağıtılır.
 * Sadece işletme verisinin tamamen kapsadığı haftalar alınır. Sonuç eskiden yeniye sıralıdır.
 */
export function weeklyBuckets(input: Pick<ForecastInput, "dataEnd" | "coverage" | "productStart" | "records" | "markers" | "maxWeeks">): WeekBucket[] {
  const maxWeeks = input.maxWeeks ?? 26;
  const out: WeekBucket[] = [];
  for (let k = 0; k < maxWeeks; k++) {
    const end = addDays(input.dataEnd, -7 * k);
    const start = addDays(end, -6);
    if (input.productStart && start < input.productStart) break;
    // Verisi eksik hafta (yüklenmemiş dönem) atlanır; sıfır satış sayılmaz.
    if (coveredDays(start, end, input.coverage) < 7) continue;
    let q = ZERO;
    for (const r of input.records) {
      const ov = overlapDays(start, end, r.start, r.end);
      if (ov === 0) continue;
      const len = daysBetween(r.start, r.end) + 1;
      q = q.plus(dec(r.qty).times(ov).div(len));
    }
    const mult = avgMultiplier(start, 7, input.markers);
    out.push({ start, end, qty: q, adjusted: mult.isZero() ? q : q.div(mult) });
  }
  return out.reverse();
}

function ceilDiv(a: Dec, b: Dec): Dec {
  return a.div(b).toDecimalPlaces(0, D.ROUND_CEIL);
}
function floorDiv(a: Dec, b: Dec): Dec {
  return a.div(b).toDecimalPlaces(0, D.ROUND_FLOOR);
}
function maxDec(...v: Dec[]): Dec {
  return v.reduce((m, x) => (x.gt(m) ? x : m));
}
function minDec(...v: Dec[]): Dec {
  return v.reduce((m, x) => (x.lt(m) ? x : m));
}

// ---------------------------------------------------------------------------
// Sipariş önerisi
// ---------------------------------------------------------------------------
export function forecastProduct(input: ForecastInput): ForecastResult {
  const notes: string[] = [];
  const pack = input.packSize && dec(input.packSize).gt(0) ? dec(input.packSize) : new D(1);
  const packLabel = input.packName && pack.gt(1) ? input.packName.toLocaleLowerCase("tr-TR") : input.baseUnit;
  let stock = dec(input.stock);
  if (stock.isNegative()) {
    notes.push("Stok eksi görünüyor; 0 kabul edildi, sayım önerilir.");
    stock = ZERO;
  }
  const onOrder = dec(input.onOrder);
  const coverDays = input.leadTimeDays + input.orderIntervalDays;

  const buckets = weeklyBuckets(input);
  const w = buckets.length;
  const windowStart = buckets[0]?.start;
  const windowRecords = windowStart ? input.records.filter((r) => r.end >= windowStart) : [];
  const coarse = windowRecords.some((r) => daysBetween(r.start, r.end) + 1 > 7);
  const granularity: ForecastResult["granularity"] = w === 0 ? "none" : coarse ? "coarse" : "weekly";
  const observations = coarse ? windowRecords.length : w;

  const empty = (confidence: Confidence, reason: string, extra: Partial<ForecastResult> = {}): ForecastResult => ({
    confidence, granularity, weeksOfData: w, observations, avgWeekly: null, weeklyDemand: null, trendPct: null,
    sigmaWeekly: null, safetyStock: ZERO, coverageDemand: ZERO, suggestedQty: ZERO, suggestedUnits: ZERO,
    rangeLowUnits: ZERO, rangeHighUnits: ZERO, packSize: pack, daysOfCover: null, reason, notes, ...extra,
  });

  if (w < 4) {
    return empty("insufficient", `Yetersiz veri: ${w} haftalık satış var, öneri için en az 4 hafta gerekli.`);
  }

  const series = buckets.map((b) => b.adjusted);
  const last8 = series.slice(-8);
  const avg8 = mean(last8);
  const { forecast } = holt(series);
  let F = maxDec(forecast, ZERO);
  if (avg8.gt(0)) {
    // Eğilimin aşırı büyümesini engelle: ortalamanın %50–%150'si arası
    F = minDec(maxDec(F, avg8.times("0.5")), avg8.times("1.5"));
  }
  const trendPct = avg8.gt(0) ? F.div(avg8).minus(1).times(100) : null;

  if (F.isZero()) {
    return empty(w > 8 ? "medium" : "low", `Son ${w} haftada satış yok; sipariş önerilmez.`, { avgWeekly: avg8, weeklyDemand: F });
  }

  // Dalgalanma
  let sigma: Dec;
  if (coarse) {
    const rates = windowRecords.map((r) => dec(r.qty).div(daysBetween(r.start, r.end) + 1).times(7));
    const avgLen = mean(windowRecords.map((r) => new D(daysBetween(r.start, r.end) + 1)));
    sigma = rates.length >= 3 ? stdDev(rates).times(avgLen.div(7).sqrt()) : F.times("0.3");
  } else {
    const recent = series.slice(-12);
    sigma = recent.length >= 3 ? stdDev(recent) : F.times("0.3");
  }

  const futureMult = avgMultiplier(addDays(input.today, 1), coverDays, input.markers);
  if (!futureMult.eq(1)) notes.push(`Önümüzdeki dönem için ×${futureMult.toDecimalPlaces(2).toString().replace(".", ",")} dönem çarpanı uygulandı.`);
  const daily = F.div(7);
  const coverageDemand = daily.times(coverDays).times(futureMult);
  const coverFactor = new D(coverDays).div(7).sqrt();
  const safetyStock = qty(Z_SERVICE.times(sigma).times(coverFactor));
  const need = coverageDemand.plus(safetyStock).minus(stock).minus(onOrder);
  const daysOfCover = daily.gt(0) ? stock.plus(onOrder).div(daily) : null;

  // Güven
  let confidence: Confidence;
  if (w <= 8) {
    confidence = "low";
  } else if (coarse) {
    confidence = "low";
    notes.push("Veri aylık/dönemlik toplam olduğu için haftalık dalgalanma ölçülemiyor; güven düşük.");
  } else {
    const active = buckets.filter((b) => b.qty.gt(0)).length / w;
    const cv = avg8.gt(0) ? sigma.div(avg8) : new D(99);
    if (w >= 12 && active >= 0.75 && cv.lte("0.5")) confidence = "high";
    else if (active >= 0.5 && cv.lte(1)) confidence = "medium";
    else confidence = "low";
  }

  const head =
    `Son ${Math.min(w, 8)} hafta: haftada ort. ${formatQty(qty(avg8), input.baseUnit)}` +
    (trendPct && trendPct.abs().gte(1) ? `, eğilim ${formatSignedPct(trendPct, 0)}` : "") +
    `. Stok ${formatQty(qty(stock), input.baseUnit)}` +
    (onOrder.gt(0) ? `, yolda ${formatQty(qty(onOrder), input.baseUnit)}` : "") +
    `, teslim ${input.leadTimeDays} gün + sipariş aralığı ${input.orderIntervalDays} gün.`;

  const base = {
    confidence, granularity, weeksOfData: w, observations, avgWeekly: avg8, weeklyDemand: F, trendPct,
    sigmaWeekly: sigma, safetyStock, coverageDemand: qty(coverageDemand), packSize: pack, daysOfCover, notes,
  };

  if (need.lte(0)) {
    return {
      ...base, suggestedQty: ZERO, suggestedUnits: ZERO, rangeLowUnits: ZERO, rangeHighUnits: ZERO,
      reason: `${head} Stok yeterli${daysOfCover ? ` (yaklaşık ${daysOfCover.toDecimalPlaces(0).toString()} gün)` : ""}.`,
    };
  }

  let needQty = need;
  const minQ = input.minOrderQty ? dec(input.minOrderQty) : ZERO;
  if (minQ.gt(needQty)) {
    needQty = minQ;
    notes.push(`Minimum sipariş miktarı (${formatQty(minQ, input.baseUnit)}) uygulandı.`);
  }
  let units = ceilDiv(needQty, pack);

  // Raf ömrü içinde satılamayacak miktar önerilmez
  let capUnits: Dec | null = null;
  if (input.shelfLifeDays && input.shelfLifeDays > 0) {
    const sellable = daily.times(input.shelfLifeDays).times(futureMult).minus(stock).minus(onOrder);
    capUnits = maxDec(floorDiv(sellable, pack), ZERO);
    if (units.gt(capUnits)) {
      units = capUnits;
      notes.push(
        capUnits.isZero()
          ? `Raf ömrü (${input.shelfLifeDays} gün) içinde bir ${packLabel} bile satılamıyor; daha küçük birimle alın.`
          : `Raf ömrü (${input.shelfLifeDays} gün) nedeniyle miktar sınırlandı.`,
      );
    }
  }

  const lowNeed = maxDec(F.minus(sigma), ZERO).div(7).times(coverDays).times(futureMult).minus(stock).minus(onOrder);
  const highNeed = F.plus(sigma).div(7).times(coverDays).times(futureMult).plus(safetyStock).minus(stock).minus(onOrder);
  let low = minDec(maxDec(ceilDiv(lowNeed, pack), ZERO), units);
  let high = maxDec(ceilDiv(highNeed, pack), units);
  if (capUnits) high = minDec(high, maxDec(capUnits, units));
  if (low.gt(high)) low = high;

  const suggestedQty = qty(units.times(pack));
  const tail = units.isZero()
    ? " Sipariş önerilmiyor."
    : ` Öneri: ${units.toString()} ${packLabel}${pack.gt(1) ? ` (${formatQty(suggestedQty, input.baseUnit)})` : ""}.`;

  return {
    ...base,
    suggestedQty,
    suggestedUnits: units,
    rangeLowUnits: low,
    rangeHighUnits: high,
    reason: head + tail,
  };
}
