import { expect } from "@playwright/test";
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

/** The left panel's "+". Adding gear and rooms lives behind it now. */
export async function openAddPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "機材と空間を追加" }).click();
  await expect(page.locator("#spaceLabel")).toBeVisible();
}

/** A form scoped by one of its own controls, so a bare "追加" stays unambiguous. */
export function formWith(page: Page, control: string) {
  return page.locator("form").filter({ has: page.locator(control) });
}

/**
 * Replaces the JSON tab's document.
 *
 * The textarea is uncontrolled, so a fill that lands before hydration gets
 * `defaultValue` appended back onto it and the paste reaches the server as
 * unparseable text. Retry until the value sticks.
 */
export async function fillSetupDoc(page: Page, json: string): Promise<void> {
  // Wait for the module scripts to land, or React replaces the textarea node
  // after the fill and the form submits the old value.
  await page.waitForLoadState("networkidle");
  const textarea = page.locator("textarea[name=doc]");
  await expect(async () => {
    await textarea.fill(json);
    await expect(textarea).toHaveValue(json, { timeout: 500 });
  }).toPass();
}
