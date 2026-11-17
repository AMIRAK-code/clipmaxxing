"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/primitives";
import { fieldNumber, type MontageSettings } from "@/lib/montage";

/** A number box that can be typed in freely: the value is checked and clamped when the box is left (or on
 * Enter), not on every key. Clamping per key turned "14" into 3 after the first digit. */
function NumberField({ label, value, lo, hi, integer, testId, onCommit }: {
  label: string;
  value: number;
  lo: number;
  hi: number;
  integer?: boolean;
  testId: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = fieldNumber(text, lo, hi, value, integer);
    setText(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <Input
      type="number"
      min={lo}
      max={hi}
      value={text}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** How many montages, and the shortest / longest length in seconds. Keeps min <= max once a box is left. */
export function MontageSettingsFields({ value, onChange }: { value: MontageSettings; onChange: (v: MontageSettings) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        How many videos
        <NumberField label="How many montages" testId="montage-count" value={value.count} lo={1} hi={20} integer
          onCommit={(count) => onChange({ ...value, count })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Shortest (s)
        <NumberField label="Shortest montage in seconds" testId="montage-min" value={value.minSec} lo={3} hi={120}
          onCommit={(minSec) => onChange({ ...value, minSec, maxSec: Math.max(minSec, value.maxSec) })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Longest (s)
        <NumberField label="Longest montage in seconds" testId="montage-max" value={value.maxSec} lo={3} hi={180}
          onCommit={(maxSec) => onChange({ ...value, maxSec, minSec: Math.min(value.minSec, maxSec) })} />
      </label>
    </div>
  );
}
