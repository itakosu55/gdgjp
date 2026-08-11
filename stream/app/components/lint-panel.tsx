import { Link } from "react-router";
import { SetupForm } from "~/components/setup-form";
import type { Diagnostic, Fix, Severity } from "~/lib/av/diagnostics";
import { canApplyFix } from "~/lib/av/mutations";
import { cn } from "~/lib/utils";

/**
 * The linter's findings, as the editor's bottom dock.
 *
 * It spans the work surface rather than sitting in a side panel because a
 * finding names a *path* (`Diagnostic.cycle`), not a node: "the mic reaches the
 * speaker that feeds it" is a horizontal fact about the whole rig. Hovering a
 * row lifts that one loop out of the picture, which is the only way to tell two
 * reported cycles apart — they both wear the danger colour.
 *
 * `data-testid="lint-panel"` and the per-finding `data-rule-id` / `data-severity`
 * are `linter.spec.ts`'s only stable hook. Keep all three when restyling.
 */

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "重大",
  error: "エラー",
  warn: "警告",
  info: "情報",
};

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-destructive",
  error: "text-destructive",
  warn: "text-amber-700 dark:text-amber-400",
  info: "text-muted-foreground",
};

const SEVERITY_STRIPE: Record<Severity, string> = {
  critical: "border-l-destructive",
  error: "border-l-destructive/60",
  warn: "border-l-amber-500/70",
  info: "border-l-border",
};

const FIX_LABEL: Record<string, string> = {
  "disable-route": "この経路を切る",
  "set-coupling": "この機材を isolated にする",
  "remove-link": "この結線を削除",
};

/**
 * A loop names the jacks it leaves and enters a space by, so the button says
 * which jack — "isolate the laptop" would deafen the presenter to fix a mic.
 * Raw port keys, as `disable-route` already does with its port and bus.
 */
function fixButtonText(fix: Fix, nodeNames: Record<string, string>): string {
  if (fix.kind === "disable-route") {
    return `${FIX_LABEL[fix.kind]} (${fix.inPort} → ${fix.bus})`;
  }
  if (fix.kind === "set-coupling") {
    const name = nodeNames[fix.nodeId];
    if (!fix.portKey) return name ? `${FIX_LABEL[fix.kind]} (${name})` : FIX_LABEL[fix.kind];
    return `この端子を isolated にする (${name ? `${name} / ` : ""}${fix.portKey})`;
  }
  return FIX_LABEL[fix.kind] ?? fix.kind;
}

export function LintPanel({
  diagnostics,
  nodeNames = {},
  spaceNames = {},
  hrefForNode,
  hrefForSpace,
  onFocus,
}: {
  diagnostics: Diagnostic[];
  /**
   * Node id → display name. A transport loop offers one `set-coupling` fix per
   * machine it passes through, and without the name every button would read
   * the same — which is worst on the finding where picking the right machine
   * is the whole decision.
   */
  nodeNames?: Record<string, string>;
  /** Space id → display name, for the "where" line. */
  spaceNames?: Record<string, string>;
  /** Selects a node in the inspector. Omit to leave findings without a link. */
  hrefForNode?: (nodeId: string) => string;
  /** Selects a space in the inspector. */
  hrefForSpace?: (spaceId: string) => string;
  /** Graph edge ids of the hovered finding's loop, or `null` on leaving it. */
  onFocus?: (edgeIds: ReadonlySet<string> | null) => void;
}) {
  if (diagnostics.length === 0) {
    return (
      <div data-testid="lint-panel" className="px-4 py-6 text-center text-sm text-muted-foreground">
        検出された問題はありません。
      </div>
    );
  }

  return (
    <div data-testid="lint-panel">
      {diagnostics.map((diagnostic, index) => {
        const where = [...new Set(diagnostic.spaceIds ?? [])]
          .map((spaceId) => spaceNames[spaceId])
          .filter((label): label is string => Boolean(label))
          .join(" / ");
        const cycle = diagnostic.cycle;
        return (
          <div
            // Rules can legitimately report more than one finding of the same id.
            key={`${diagnostic.ruleId}-${index}`}
            // Read by the e2e suite; keep both attributes when restyling.
            data-rule-id={diagnostic.ruleId}
            data-severity={diagnostic.severity}
            onMouseEnter={
              cycle && onFocus ? () => onFocus(new Set(cycle.map((edge) => edge.id))) : undefined
            }
            onMouseLeave={cycle && onFocus ? () => onFocus(null) : undefined}
            className={cn(
              "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 border-b border-l-2 px-3 py-2.5 last:border-b-0 hover:bg-secondary",
              SEVERITY_STRIPE[diagnostic.severity],
            )}
          >
            <span className={cn("text-xs font-semibold", SEVERITY_TEXT[diagnostic.severity])}>
              {SEVERITY_LABEL[diagnostic.severity]}
            </span>
            <div className="min-w-0">
              <div className="mb-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <code className="text-xs text-muted-foreground">{diagnostic.ruleId}</code>
                {where ? <span className="text-xs text-muted-foreground">{where}</span> : null}
              </div>
              <p className="text-sm">{diagnostic.message}</p>
              <div className="mt-1.5 flex flex-wrap gap-2 empty:mt-0">
                {(diagnostic.fixes ?? []).filter(canApplyFix).map((fix) => (
                  <SetupForm key={JSON.stringify(fix)}>
                    <input type="hidden" name="intent" value="apply-fix" />
                    <input type="hidden" name="fix" value={JSON.stringify(fix)} />
                    <button
                      type="submit"
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-secondary"
                    >
                      {fixButtonText(fix, nodeNames)}
                    </button>
                  </SetupForm>
                ))}
                {/*
                 * A fix `canApplyFix` refuses is still worth showing — it just
                 * cannot be a button. `declare-reinforced` asserts a fact about
                 * the room, so it is a link to the place a person answers for
                 * it (§13.6).
                 */}
                {hrefForSpace
                  ? (diagnostic.fixes ?? [])
                      .filter((fix) => fix.kind === "declare-reinforced")
                      .map((fix) => (
                        <Link
                          key={fix.spaceId}
                          to={hrefForSpace(fix.spaceId)}
                          replace
                          data-fix-kind="declare-reinforced"
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          {spaceNames[fix.spaceId] ?? "空間"} の設定を開く
                        </Link>
                      ))
                  : null}
                {hrefForNode
                  ? diagnostic.nodeIds
                      .filter((nodeId) => nodeNames[nodeId])
                      .slice(0, 3)
                      .map((nodeId) => (
                        <Link
                          key={nodeId}
                          to={hrefForNode(nodeId)}
                          replace
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          {nodeNames[nodeId]} を開く
                        </Link>
                      ))
                  : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function severityCounts(diagnostics: Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

export function SeverityChips({ counts }: { counts: Record<Severity, number> }) {
  return (
    <>
      {counts.critical > 0 ? (
        <span className="rounded bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground">
          重大 {counts.critical}
        </span>
      ) : null}
      {counts.error > 0 ? (
        <span className="rounded border border-destructive/50 px-1.5 py-0.5 text-xs text-destructive">
          エラー {counts.error}
        </span>
      ) : null}
      {counts.warn > 0 ? (
        <span className="rounded border border-amber-500/50 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
          警告 {counts.warn}
        </span>
      ) : null}
      {counts.info > 0 ? (
        <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
          情報 {counts.info}
        </span>
      ) : null}
    </>
  );
}
