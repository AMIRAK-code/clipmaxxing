"use client";

import { fontStack, fontWeightOf, HOOK_BASE_SIZE, isTransparent, type HookStyle } from "@klipz/shared";

/** Small static render of a hook card style, so the presets can be compared at a glance. */
export function HookMini({ style, scale = 0.16, text = "Hook" }: { style: HookStyle; scale?: number; text?: string }) {
  const u = style.fontSize / HOOK_BASE_SIZE;
  const boxed = !isTransparent(style.background);
  return (
    <span
      data-hook-style={style.id}
      style={{
        fontFamily: fontStack(style.fontFamily),
        fontWeight: fontWeightOf(style.fontFamily),
        fontSize: Math.max(11, style.fontSize * scale),
        lineHeight: 1.1,
        color: style.color,
        background: boxed ? style.background : "transparent",
        padding: `${28 * u * scale}px ${40 * u * scale}px`,
        borderRadius: 32 * u * scale,
        WebkitTextStroke: style.strokeWidth > 0 ? `${Math.max(0.5, style.strokeWidth * scale)}px ${style.strokeColor}` : undefined,
        paintOrder: "stroke fill",
        whiteSpace: "nowrap",
      }}
    >
      {style.uppercase ? text.toUpperCase() : text}
    </span>
  );
}
