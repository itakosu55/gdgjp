import { Form } from "react-router";
import type { Diagnostic, Severity } from "~/lib/av/diagnostics";
import { canApplyFix } from "~/lib/av/mutations";
import { cn } from "~/lib/utils";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "重大",
  error: "エラー",
  warn: "警告",
  info: "情報",
};

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "border-destructive/60 bg-destructive/10 text-destructive",
  error: "border-destructive/40 bg-destructive/5 text-destructive",
  warn: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  info: "border-border bg-muted text-muted-foreground",
};

const FIX_LABEL: Record<string, string> = {
  "disable-route": "この経路を切る",
  "set-coupling": "この機材を isolated にする",
  "remove-link": "この結線を削除",
};

export function LintPanel({
  diagnostics,
  nodeNames = {},
}: {
  diagnostics: Diagnostic[];
  /**
   * Node id → display name. A transport loop offers one `set-coupling` fix per
   * machine it passes through, and without the name every button would read
   * the same — which is worst on the finding where picking the right machine
   * is the whole decision.
   */
  nodeNames?: Record<string, string>;
}) {
  if (diagnostics.length === 0) {
    return (
      <div
        data-testid="lint-panel"
        className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      >
        検出された問題はありません。
      </div>
    );
  }

  return (
    <div data-testid="lint-panel" className="flex flex-col gap-3">
      {diagnostics.map((diagnostic, index) => (
        <div
          // Rules can legitimately report more than one finding of the same id.
          key={`${diagnostic.ruleId}-${index}`}
          // Read by the e2e suite; keep both attributes when restyling.
          data-rule-id={diagnostic.ruleId}
          data-severity={diagnostic.severity}
          className={cn("rounded-lg border p-3 text-sm", SEVERITY_STYLE[diagnostic.severity])}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-current/30 px-1.5 py-0.5 text-xs font-medium">
              {SEVERITY_LABEL[diagnostic.severity]}
            </span>
            <code className="text-xs opacity-70">{diagnostic.ruleId}</code>
          </div>
          <p className="mt-2 text-foreground">{diagnostic.message}</p>
          {diagnostic.fixes && diagnostic.fixes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {diagnostic.fixes.filter(canApplyFix).map((fix) => (
                <Form key={JSON.stringify(fix)} method="post">
                  <input type="hidden" name="intent" value="apply-fix" />
                  <input type="hidden" name="fix" value={JSON.stringify(fix)} />
                  <button
                    type="submit"
                    className="rounded border border-current/40 bg-background/60 px-2 py-1 text-xs text-foreground hover:bg-background"
                  >
                    {FIX_LABEL[fix.kind] ?? fix.kind}
                    {fix.kind === "disable-route" ? ` (${fix.inPort} → ${fix.bus})` : null}
                    {fix.kind === "set-coupling" && nodeNames[fix.nodeId]
                      ? ` (${nodeNames[fix.nodeId]})`
                      : null}
                  </button>
                </Form>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function severityCounts(diagnostics: Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}
