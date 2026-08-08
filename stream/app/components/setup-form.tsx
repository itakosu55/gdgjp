import type { ReactNode } from "react";
import { useFetcher } from "react-router";

/**
 * Every form in the setup editor.
 *
 * A fetcher rather than a plain `<Form>` because a navigation is the wrong
 * shape for this screen: the editor is one page whose state — which view, what
 * is selected, how far the diagram is scrolled, which panels are open — has to
 * survive an edit, and a navigation throws the last two away. It is also what
 * lets `useOptimisticDoc` see the submission while it is still in flight.
 *
 * One fetcher per form instance, deliberately: a shared key would make a second
 * click cancel the first, and every one of these is a separate deliberate edit.
 * Two edits fired inside the same round trip still race at the database — the
 * action reads the document, applies one intent and writes it whole — which is
 * a pre-existing property of a single-document-column schema, not something the
 * fetchers introduced.
 *
 * Without JavaScript these submit as ordinary forms and the server does the
 * same thing, so the editor still works; it just stops feeling live.
 */
export function SetupForm({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const fetcher = useFetcher();
  const error = (fetcher.data as { error?: string } | undefined)?.error;
  return (
    <fetcher.Form method="post" className={className}>
      {children}
      {/* Under the form that was refused, not in the status bar. A refusal is
          always about what this form asked for — "JSON として読み取れません。"
          means the box directly above — and `useFetchers` cannot carry it
          anywhere else anyway: the router drops an idle fetcher from that list
          one render after it settles, so a shared reader sees the message
          flash and vanish. */}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fetcher.Form>
  );
}
