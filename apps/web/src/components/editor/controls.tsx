"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-line px-3 py-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-24 shrink-0 text-xs text-muted">
        {label}
      </label>
      <input
        id={id}
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer"
      />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg">{format ? format(value) : value}</span>
    </div>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <Row label={label}>
      <input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="h-8 w-24 rounded-lg border border-line bg-bg px-2 text-right text-xs tabular-nums"
      />
      {suffix ? <span className="w-4 text-xs text-muted">{suffix}</span> : null}
    </Row>
  );
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : toHex(value);
  return (
    <Row label={label}>
      <span className="text-[10px] uppercase tabular-nums text-muted">{hex}</span>
      <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent p-0.5" />
    </Row>
  );
}

/** Best-effort #rrggbb for the colour picker (rgba()/short hex/named fall back to white). */
export function toHex(v: string): string {
  const s = v.trim();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  return "#ffffff";
}

export function SelectInput<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <Row label={label}>
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 text-xs"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}
