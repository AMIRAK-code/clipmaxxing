"use client";

import type { Provider } from "@klipz/shared";
import { useEffect, useMemo, useState } from "react";
import { Input, Select } from "@/components/ui/primitives";
import { checkSchedule, formatInZone, formatUtc, listTimeZones, localValueIn } from "@/lib/schedule";
import { PROVIDER_META } from "@/lib/social-ui";
import type { BestTimesResponse } from "@/lib/social-api";
import { api, cn } from "@/lib/utils";

export interface ScheduleValue {
  mode: "now" | "schedule";
  /** datetime-local value (wall clock in `timezone`) */
  local: string;
  timezone: string;
}

export function SchedulePicker({ value, onChange, providers }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void; providers: Provider[] }) {
  const zones = useMemo(() => {
    const z = listTimeZones();
    return z.includes(value.timezone) ? z : [value.timezone, ...z];
  }, [value.timezone]);
  const [best, setBest] = useState<BestTimesResponse | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  const key = providers.join(",");
  useEffect(() => {
    if (value.mode !== "schedule" || providers.length === 0) return;
    let cancelled = false;
    api<BestTimesResponse>(`/api/posts/best-times?providers=${encodeURIComponent(key)}&timezone=${encodeURIComponent(value.timezone)}`)
      .then((r) => !cancelled && setBest(r))
      .catch(() => !cancelled && setBest(null));
    return () => {
      cancelled = true;
    };
  }, [value.mode, value.timezone, key, providers.length]);

  const check = value.mode === "schedule" ? checkSchedule(value.local, value.timezone, now) : null;
  const radio = "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold";

  return (
    <div className="flex flex-col gap-3" data-testid="schedule-picker">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="When to post">
        <label className={cn(radio, value.mode === "now" ? "border-accent bg-accent/10" : "border-line")}>
          <input type="radio" name="when" checked={value.mode === "now"} onChange={() => onChange({ ...value, mode: "now" })} aria-label="Post now" data-testid="when-now" /> Post now
        </label>
        <label className={cn(radio, value.mode === "schedule" ? "border-accent bg-accent/10" : "border-line")}>
          <input
            type="radio"
            name="when"
            checked={value.mode === "schedule"}
            onChange={() => onChange({ ...value, mode: "schedule", local: value.local || localValueIn(value.timezone, new Date(), 10) })}
            aria-label="Schedule for later"
            data-testid="when-schedule"
          />{" "}
          Schedule
        </label>
      </div>

      {value.mode === "schedule" ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              Date and time
              <Input type="datetime-local" value={value.local} onChange={(e) => onChange({ ...value, local: e.target.value })} className="w-56" data-testid="schedule-local" aria-invalid={check ? !check.ok : undefined} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              Time zone
              <Select
                value={value.timezone}
                onChange={(e) => {
                  onChange({ ...value, timezone: e.target.value });
                }}
                className="w-64"
                data-testid="schedule-tz"
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          {check?.ok && check.utc ? (
            <p className="text-sm" data-testid="schedule-preview">
              Goes out <strong>{formatInZone(check.utc, value.timezone)}</strong> <span className="text-muted">= {formatUtc(check.utc)}</span>
              {check.note ? <span className="mt-1 block text-xs text-warn">{check.note}</span> : null}
            </p>
          ) : (
            <p role="alert" className="text-sm text-bad" data-testid="schedule-error">
              {check?.error}
            </p>
          )}
          <p className="text-xs text-muted">Scheduled posts go out only while KLIPZ is running on this PC (checked every 15 s). Anything missed is published when you start it again.</p>

          {best ? (
            <div className="flex flex-col gap-1.5" data-testid="best-times">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Suggested times ({best.timezone})</p>
              <div className="flex flex-wrap gap-2">
                {providers.flatMap((p) => {
                  const s = best.suggestions[p];
                  if (!s) return [];
                  return s.slots.map((slot) => (
                    <button
                      key={`${p}-${slot.at}`}
                      type="button"
                      title={slot.reason}
                      onClick={() => onChange({ ...value, mode: "schedule", timezone: best.timezone, local: slot.local.replace(" ", "T") })}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-panel-2 px-3 py-1 text-xs font-semibold hover:border-accent"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: PROVIDER_META[p].color }} aria-hidden />
                      {PROVIDER_META[p].label} · {slot.local}
                      <span className="font-normal text-muted">{s.basis === "history" ? "your data" : "general"}</span>
                    </button>
                  ));
                })}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
