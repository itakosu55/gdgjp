import type { Page } from "@playwright/test";

/** Rule ids currently reported, in the order the panel shows them. */
export async function ruleIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="lint-panel"] [data-rule-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-rule-id") ?? ""));
}

export function diagnostic(page: Page, ruleId: string) {
  return page.locator(`[data-testid="lint-panel"] [data-rule-id="${ruleId}"]`);
}
