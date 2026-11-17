"use client";

import { Input } from "@/components/ui/primitives";
import type { MontageSettings } from "@/lib/montage";

/** How many montages, and the shortest / longest length in seconds. Keeps min <= max while typing. */
export function MontageSettingsFields({ value, onChange }: { value: MontageSettings; onChange: (v: MontageSettings) => void }) {
  const num = (raw: string, lo: number, hi: number, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return (
    <div className="grid grid-cols-3 gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        How many videos
        <Input
          type="number"
          min={1}
          max={20}
          value={value.count}
          aria-label="How many montages"
          data-testid="montage-count"
          onChange={(e) => onChange({ ...value, count: Math.round(num(e.target.value, 1, 20, value.count)) })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Shortest (s)
        <Input
          type="number"
          min={3}
          max={120}
          value={value.minSec}
          aria-label="Shortest montage in seconds"
          data-testid="montage-min"
          onChange={(e) => {
            const minSec = num(e.target.value, 3, 120, value.minSec);
            onChange({ ...value, minSec, maxSec: Math.max(minSec, value.maxSec) });
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Longest (s)
        <Input
          type="number"
          min={3}
          max={180}
          value={value.maxSec}
          aria-label="Longest montage in seconds"
          data-testid="montage-max"
          onChange={(e) => {
            const maxSec = num(e.target.value, 3, 180, value.maxSec);
            onChange({ ...value, maxSec, minSec: Math.min(value.minSec, maxSec) });
          }}
        />
      </label>
    </div>
  );
}
