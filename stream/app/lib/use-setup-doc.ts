import { useMemo } from "react";
import { useFetchers } from "react-router";
import type { SetupDoc } from "~/lib/av/schema";
import type { IntentCatalog } from "~/lib/setup-intents";
import { applyIntent, isOptimistic } from "~/lib/setup-intents";

/**
 * The document as it will be once every submission in flight has landed.
 *
 * The editor posts through fetchers rather than navigations, so a click never
 * takes the page away; this is the other half of that. Every pending form is
 * replayed through `applyIntent` — the same function the server runs — so the
 * diagram re-lays out, the linter re-runs and the tree re-groups on the click
 * rather than on the response. Toggling a matrix cell to see whether the howl
 * goes away is the whole loop this app exists for, and a round trip per cell
 * made people stop trying combinations.
 *
 * Replaying rather than patching is what keeps this honest: an optimistic
 * result that came from a second implementation of "what does `toggle-route`
 * mean" would be a *different* answer than the one being saved, and the
 * disagreement would only show up on the reload.
 */
export function useOptimisticDoc(
  saved: SetupDoc,
  catalog: IntentCatalog,
): { doc: SetupDoc; busy: boolean } {
  const fetchers = useFetchers();

  const pending: FormData[] = [];
  let busy = false;
  for (const fetcher of fetchers) {
    if (fetcher.state !== "idle") busy = true;
    const form = fetcher.formData;
    if (!form) continue;
    if (!isOptimistic(String(form.get("intent") ?? ""))) continue;
    pending.push(form);
  }

  // `useFetchers` hands back a fresh array every render, so the fold has to be
  // keyed on what the submissions actually say. Without this the document would
  // be a new object each time and `layoutGraph` would run on every render.
  const signature = pending.map(describe).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands in for `pending`.
  return useMemo(() => {
    let doc = saved;
    for (const form of pending) {
      const outcome = applyIntent(doc, form, catalog);
      // An intent the server will reject changes nothing here either. Reporting
      // it is the server's job — it is the one that knows the edit failed.
      if (outcome.kind === "doc") doc = outcome.doc;
    }
    return { doc, busy };
  }, [saved, catalog, signature, busy]);
}

function describe(form: FormData): string {
  return [...form].map(([key, value]) => `${key}=${String(value)}`).join("&");
}
