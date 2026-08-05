import type { ReactNode } from "react";
import { Header, type HeaderUser } from "~/components/header";
import { cn } from "~/lib/utils";

export function Page({
  user,
  title,
  description,
  actions,
  breadcrumb,
  wide,
  children,
}: {
  user: HeaderUser | null;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <Header user={user} />
      <main className={cn("mx-auto px-4 py-8", wide ? "max-w-6xl" : "max-w-4xl")}>
        {breadcrumb ? <div className="mb-2 text-sm text-muted-foreground">{breadcrumb}</div> : null}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}

export const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
