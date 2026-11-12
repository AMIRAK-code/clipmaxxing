"use client";

import { BarChart3, Clapperboard, FolderOpen, Send, Settings, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useJobs } from "@/hooks/use-jobs";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Projects", icon: Clapperboard, match: (p: string) => p === "/" || p.startsWith("/projects") || p.startsWith("/clips") },
  { href: "/library", label: "Library", icon: FolderOpen, match: (p: string) => p.startsWith("/library") },
  { href: "/posts", label: "Posts", icon: Send, match: (p: string) => p.startsWith("/posts") || p.startsWith("/compose") },
  { href: "/accounts", label: "Accounts", icon: Users, match: (p: string) => p.startsWith("/accounts") },
  { href: "/analytics", label: "Analytics", icon: BarChart3, match: (p: string) => p.startsWith("/analytics") },
  { href: "/ai", label: "AI", icon: Sparkles, match: (p: string) => p === "/ai" || p.startsWith("/ai/") },
  { href: "/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

export function Sidebar() {
  const pathname = usePathname();
  const { jobs, workerAlive } = useJobs(undefined);
  const busy = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  // The editor is full-bleed; keep the rail narrow there.
  const compact = pathname.startsWith("/clips/");

  return (
    <aside className={cn("flex shrink-0 flex-col border-r border-line bg-panel", compact ? "w-14" : "w-52")}>
      <Link href="/" className="flex h-14 items-center gap-2 px-4 text-lg font-black tracking-tight">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm text-white">K</span>
        {!compact && <span>KLIPZ</span>}
      </Link>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map((n) => {
          const active = n.match(pathname);
          return (
            <Link
              key={n.href}
              href={n.href}
              title={n.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors",
                active ? "bg-accent/15 text-accent-2" : "text-muted hover:bg-panel-2 hover:text-fg",
              )}
            >
              <n.icon className="h-4 w-4 shrink-0" />
              {!compact && n.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line p-3 text-xs text-muted" title={workerAlive ? "Worker is running" : "Start KLIPZ with npm start (worker alone: npm run worker)"}>
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", workerAlive ? "bg-good" : workerAlive === false ? "bg-bad" : "bg-line")} />
          {!compact && (
            <span>
              {workerAlive ? (busy ? `Worker busy · ${busy} job${busy === 1 ? "" : "s"}` : "Worker idle") : workerAlive === false ? "Worker offline" : "Checking worker…"}
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
