"use client";

import { PROVIDERS, type Provider } from "@klipz/shared";
import { useState } from "react";
import { areaPath, labelIndices, linePath, linePoints, linearScale, niceTicks, plotArea, slotX, stackSegments, type Box } from "@/lib/chart";
import { PROVIDER_META } from "@/lib/social-ui";
import type { AnalyticsResponse } from "@/lib/social-api";
import { formatCount } from "@/lib/utils";

type Series = AnalyticsResponse["series"];
const BOX: Box = { width: 720, height: 260, padL: 52, padR: 12, padT: 14, padB: 34 };

/**
 * Hand-rolled SVG chart. "Gained" = stacked bars of views gained per day per platform;
 * "Total" = line of cumulative views. Each mark has a <title> tooltip, the figure has a text
 * summary and a screen-reader data table.
 */
export function ViewsChart({ series, mode }: { series: Series; mode: "gained" | "total" }) {
  const [hover, setHover] = useState<number | null>(null);
  if (series.length === 0) return null;

  const providers = PROVIDERS.filter((p) => series.some((s) => (s.byProvider[p]?.views ?? 0) > 0));
  const values = series.map((s) => (mode === "gained" ? Math.max(0, s.viewsDelta) : s.views));
  const maxV = Math.max(1, ...values);
  const ticks = niceTicks(maxV, 4);
  const top = ticks[ticks.length - 1]!;
  const { x0, x1, y0, y1 } = plotArea(BOX);
  const yOf = linearScale(0, top, y0, y1);
  const cx = slotX(series.length, BOX);
  const slot = (x1 - x0) / series.length;
  const barW = Math.min(44, slot * 0.7);
  const labelAt = new Set(labelIndices(series.length, 7));
  const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const summary =
    mode === "gained"
      ? `Views gained per day, ${series.length} day${series.length === 1 ? "" : "s"} with data, peak ${formatCount(maxV)} views.`
      : `Total views over time, ${series.length} day${series.length === 1 ? "" : "s"} with data, now ${formatCount(series.at(-1)!.views)} views.`;

  const pts = linePoints(values, BOX, top);
  const tip = hover !== null ? series[hover] : undefined;

  return (
    <figure className="m-0" data-testid="views-chart">
      <div className="relative">
        <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={summary} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
          <title>{summary}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x0} x2={x1} y1={yOf(t)} y2={yOf(t)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={x0 - 8} y={yOf(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">
                {formatCount(t)}
              </text>
            </g>
          ))}
          {mode === "gained"
            ? series.map((s, i) => {
                const segs = stackSegments(providers.map((p) => Math.max(0, s.byProvider[p]?.viewsDelta ?? 0)), yOf, y0);
                const x = cx(i) - barW / 2;
                return (
                  <g key={s.date} onMouseEnter={() => setHover(i)}>
                    <rect x={cx(i) - slot / 2} y={y1} width={slot} height={y0 - y1} fill="transparent" />
                    {segs.map((g, k) =>
                      g.h > 0 ? (
                        <rect key={providers[k]} x={x} y={g.y} width={barW} height={g.h} fill={PROVIDER_META[providers[k]!].color} rx={k === segs.length - 1 ? 2 : 0}>
                          <title>{`${shortDate(s.date)} · ${PROVIDER_META[providers[k]!].label}: +${(g.to - g.from).toLocaleString()} views`}</title>
                        </rect>
                      ) : null,
                    )}
                    {labelAt.has(i) && s.viewsDelta > 0 ? (
                      <text x={cx(i)} y={yOf(Math.max(0, s.viewsDelta)) - 5} textAnchor="middle" fontSize={11} fill="var(--color-fg)">
                        {formatCount(s.viewsDelta)}
                      </text>
                    ) : null}
                  </g>
                );
              })
            : (
              <g>
                <path d={areaPath(pts, y0)} fill="var(--color-accent)" opacity={0.15} />
                <path d={linePath(pts)} fill="none" stroke="var(--color-accent-2)" strokeWidth={2.5} strokeLinejoin="round" />
                {pts.map((p, i) => (
                  <g key={series[i]!.date} onMouseEnter={() => setHover(i)}>
                    <circle cx={p.x} cy={p.y} r={10} fill="transparent" />
                    <circle cx={p.x} cy={p.y} r={3.5} fill="var(--color-accent-2)">
                      <title>{`${shortDate(series[i]!.date)}: ${series[i]!.views.toLocaleString()} views`}</title>
                    </circle>
                    {labelAt.has(i) ? (
                      <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize={11} fill="var(--color-fg)">
                        {formatCount(series[i]!.views)}
                      </text>
                    ) : null}
                  </g>
                ))}
              </g>
            )}
          {series.map((s, i) =>
            labelAt.has(i) ? (
              <text key={s.date} x={cx(i)} y={y0 + 18} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
                {shortDate(s.date)}
              </text>
            ) : null,
          )}
        </svg>
        {tip ? (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-xs shadow-lg" aria-hidden>
            <p className="font-semibold">{shortDate(tip.date)}</p>
            <p className="tabular-nums">{mode === "gained" ? `+${tip.viewsDelta.toLocaleString()} views` : `${tip.views.toLocaleString()} views`}</p>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {mode === "gained"
          ? providers.map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PROVIDER_META[p].color }} aria-hidden />
                {PROVIDER_META[p].label}
              </span>
            ))
          : <span>Cumulative views across all published posts</span>}
        <span className="ml-auto">The first day with data also includes everything counted before it.</span>
      </figcaption>
      <table className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Total views</th>
            <th scope="col">Views gained</th>
            {providers.map((p) => (
              <th key={p} scope="col">{PROVIDER_META[p].label} gained</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.date}>
              <th scope="row">{s.date}</th>
              <td>{s.views}</td>
              <td>{s.viewsDelta}</td>
              {providers.map((p: Provider) => (
                <td key={p}>{s.byProvider[p]?.viewsDelta ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
