import { Compass } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-16 text-center">
      <Compass className="h-10 w-10 text-muted" aria-hidden />
      <h1 className="text-2xl font-black tracking-tight">Page not found</h1>
      <p className="text-sm text-muted">That page, project or clip does not exist (it may have been deleted).</p>
      <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-2">
        Back to projects
      </Link>
    </div>
  );
}
