"use client";

import { type ReactNode, useId, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/cn";

// Colours come from the design system's validated viz tokens (see globals.css);
// they switch with dark mode because they are CSS variables.
export const SERIES = {
  primary: "var(--color-viz-1)",
  secondary: "var(--color-viz-2)",
  muted: "var(--color-muted-foreground)",
} as const;

export type Series = { key: string; label: string; color: string; dashed?: boolean };
export type Datum = { label: string } & Record<string, number | string | null>;

const AXIS_TICK = { fontSize: 11, fill: "var(--color-muted-foreground)" };

function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
  labelFormat,
}: Partial<TooltipContentProps<number, string>> & { series: Series[]; format: (value: number) => string; labelFormat?: (label: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-40 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{labelFormat ? labelFormat(String(label)) : String(label)}</p>
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.key);
        if (!entry || entry.value === null || entry.value === undefined) return null;
        return (
          <p key={s.key} className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
            <span className="ms-auto ps-3 font-medium text-foreground tabular-nums">{format(Number(entry.value))}</span>
          </p>
        );
      })}
    </div>
  );
}

/** Legend for two or more series: the identity channel that is not colour alone. */
export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span
            className={cn("h-0.5 w-3 rounded-full", s.dashed && "border-t-2 border-dashed bg-transparent")}
            style={s.dashed ? { borderColor: s.color } : { backgroundColor: s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Every chart's data is also readable as a table. */
export function DataTable({
  data,
  series,
  format,
  labelHeader = "Period",
}: {
  data: Datum[];
  series: Series[];
  format: (value: number) => string;
  labelHeader?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[11px] text-muted-foreground hover:text-foreground">
        {open ? "Hide data" : "Show data"}
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
                <th>{labelHeader}</th>
                {series.map((s) => (
                  <th key={s.key} className="text-right!">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((row) => (
                <tr key={row.label} className="[&>td]:px-2 [&>td]:py-1">
                  <td>{row.label}</td>
                  {series.map((s) => (
                    <td key={s.key} className="text-right tabular-nums">
                      {row[s.key] === null || row[s.key] === undefined ? "—" : format(Number(row[s.key]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Common = {
  data: Datum[];
  series: Series[];
  format: (value: number) => string;
  /** Compact axis ticks, e.g. ৳1.2L. */
  axisFormat?: (value: number) => string;
  labelFormat?: (label: string) => string;
  tickFormat?: (label: string) => string;
  height?: number;
  className?: string;
  footer?: ReactNode;
  table?: boolean;
};

/** Change over time for one or two measures: 2px lines over a 10% wash. */
export function TrendChart({
  data,
  series,
  format,
  axisFormat,
  labelFormat,
  tickFormat,
  height = 220,
  className,
  table = true,
  zeroLine,
}: Common & { zeroLine?: boolean }) {
  const gradientId = useId().replace(/:/g, "");
  return (
    <div className={cn("space-y-2", className)}>
      <Legend series={series} />
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={20} tick={AXIS_TICK} tickFormatter={tickFormat} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={AXIS_TICK} tickFormatter={(v: number) => (axisFormat ?? format)(v)} />
            {zeroLine && <ReferenceLine y={0} stroke="var(--color-border)" />}
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)", strokeOpacity: 0.4, strokeWidth: 1 }}
              content={(props) => (
                <ChartTooltip {...(props as TooltipContentProps<number, string>)} series={series} format={format} labelFormat={labelFormat} />
              )}
            />
            {series.map((s, index) =>
              index === 0 && !s.dashed ? (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#${gradientId}-${s.key})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-card)" }}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ) : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? "4 4" : undefined}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-card)" }}
                  isAnimationActive={false}
                  connectNulls
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {table && <DataTable data={data} series={series} format={format} />}
    </div>
  );
}

/** Magnitudes per period, side by side: ≤24px bars, 4px rounded tops, 2px gaps. */
export function BarsChart({ data, series, format, axisFormat, labelFormat, tickFormat, height = 220, className, table = true }: Common) {
  return (
    <div className={cn("space-y-2", className)}>
      <Legend series={series} />
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="24%" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={12} tick={AXIS_TICK} tickFormatter={tickFormat} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={AXIS_TICK} tickFormatter={(v: number) => (axisFormat ?? format)(v)} />
            <Tooltip
              cursor={{ fill: "var(--color-accent)", opacity: 0.6 }}
              content={(props) => (
                <ChartTooltip {...(props as TooltipContentProps<number, string>)} series={series} format={format} labelFormat={labelFormat} />
              )}
            />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {table && <DataTable data={data} series={series} format={format} />}
    </div>
  );
}

/**
 * A projection: the expected line, an 80% band around it, and an optional
 * threshold. The chart says "estimate" in its legend, never just the numbers.
 */
export function ForecastChart({
  data,
  format,
  axisFormat,
  labelFormat,
  tickFormat,
  height = 240,
  threshold,
  className,
}: Omit<Common, "series"> & { threshold?: { value: number; label: string } | null }) {
  const withRange = data.map((d) => ({ ...d, range: [Number(d.low), Number(d.high)] as unknown as number }));
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: SERIES.primary }} /> Projected balance (estimate)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm opacity-20" style={{ backgroundColor: SERIES.primary }} /> Likely range (80%)
        </span>
        {threshold && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 border-t border-dashed border-muted-foreground" /> {threshold.label}
          </span>
        )}
      </div>
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={withRange} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={AXIS_TICK} tickFormatter={tickFormat} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={AXIS_TICK} tickFormatter={(v: number) => (axisFormat ?? format)(v)} />
            {threshold && <ReferenceLine y={threshold.value} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" />}
            <ReferenceLine y={0} stroke="var(--color-border)" />
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)", strokeOpacity: 0.4 }}
              content={(props) => (
                <ChartTooltip
                  {...(props as TooltipContentProps<number, string>)}
                  series={[
                    { key: "balance", label: "Projected", color: SERIES.primary },
                    { key: "low", label: "Low", color: "var(--color-border)" },
                    { key: "high", label: "High", color: "var(--color-border)" },
                  ]}
                  format={format}
                  labelFormat={labelFormat}
                />
              )}
            />
            <Area dataKey="range" stroke="none" fill={SERIES.primary} fillOpacity={0.1} isAnimationActive={false} />
            <Line dataKey="low" stroke="none" dot={false} isAnimationActive={false} />
            <Line dataKey="high" stroke="none" dot={false} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="balance"
              stroke={SERIES.primary}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-card)" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <DataTable
        data={data}
        series={[
          { key: "balance", label: "Projected", color: SERIES.primary },
          { key: "low", label: "Low", color: "" },
          { key: "high", label: "High", color: "" },
        ]}
        format={format}
        labelHeader="Date"
      />
    </div>
  );
}
