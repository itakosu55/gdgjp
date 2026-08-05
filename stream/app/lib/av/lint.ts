import type { Diagnostic, LintContext, Rule } from "./diagnostics";
import { sortDiagnostics } from "./diagnostics";
import { buildGraph } from "./graph";
import { connectionRules } from "./rules/connections";
import { coverageRules } from "./rules/coverage";
import { loopRules } from "./rules/loops";
import { structureRules } from "./rules/structure";
import type { SetupDoc } from "./schema";

const RULES: Rule[] = [structureRules, connectionRules, loopRules, coverageRules];

/**
 * Checks one setup and returns findings ordered most severe first.
 *
 * `ctx` is deliberately a second parameter rather than extra arguments: when
 * simultaneous tracks arrive, `siblingSetups` carries the other tracks' setups
 * and no rule signature has to change.
 */
export function lint(doc: SetupDoc, ctx: LintContext): Diagnostic[] {
  const graph = buildGraph(doc, { devices: ctx.devices, models: ctx.models });
  return sortDiagnostics(RULES.flatMap((rule) => rule(graph, ctx)));
}
