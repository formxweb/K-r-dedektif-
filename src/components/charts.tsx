"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, ComposedChart } from "recharts";
import { formatNumber, formatTL } from "@/lib/domain/format";

// Değerler metin (decimal) olarak gelir; sadece çizim geometrisi için sayıya çevrilir.
const toNum = (s: string) => Number(s);

const axis = { fontSize: 12, fill: "#5a6476" };

export function QtyBars({ data, unit }: { data: Array<{ label: string; qty: string }>; unit: string }) {
  if (data.length === 0) return null;
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <BarChart data={data.map((d) => ({ ...d, v: toNum(d.qty) }))} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="#e3e6eb" />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: "#cfd5de" }} interval="preserveStartEnd" minTickGap={16} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => formatNumber(String(v), 0)} />
          <Tooltip cursor={{ fill: "#f3f4f6" }} formatter={(_, __, item) => [`${formatNumber(item.payload.qty, 0)} ${unit}`, "Satış"]} labelStyle={{ color: "#0d1829" }} contentStyle={{ borderRadius: 6, border: "1px solid #e3e6eb", fontSize: 13 }} />
          <Bar dataKey="v" fill="#1a2a44" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MonthlyPnlChart({ data }: { data: Array<{ label: string; sales: string; gross: string; operating: string }> }) {
  if (data.length === 0) return null;
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data.map((d) => ({ ...d, s: toNum(d.sales), g: toNum(d.gross), o: toNum(d.operating) }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="#e3e6eb" />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: "#cfd5de" }} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatNumber(String(v), 0)} />
          <Tooltip
            cursor={{ fill: "#f3f4f6" }}
            contentStyle={{ borderRadius: 6, border: "1px solid #e3e6eb", fontSize: 13 }}
            formatter={(_, name, item) => {
              const key = name === "s" ? "sales" : name === "g" ? "gross" : "operating";
              const label = name === "s" ? "Net satış" : name === "g" ? "Brüt kâr" : "Faaliyet sonucu";
              return [formatTL(item.payload[key]), label];
            }}
          />
          <Bar dataKey="s" fill="#d7dde7" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="g" fill="#1a2a44" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Line dataKey="o" stroke="#0b7a4b" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
