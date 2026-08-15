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
  await expect(page.locator("#placeLabel")).toBeVisible();
}

/** A form scoped by one of its own controls, so a bare "追加" stays unambiguous. */
export function formWith(page: Page, control: string) {
  return page.locator("form").filter({ has: page.locator(control) });
}

/**
 * Runs an edit and waits for it to reach the server.
 *
 * The editor applies an edit in the browser before the round trip lands, so an
 * assertion that it worked now passes while the POST is still in the air. Two
 * things then break silently: navigating away aborts the write, and the next
 * test in a serial group starts from a document that was never saved. Anything
 * whose effect has to outlive the current page needs this.
 */
export async function saving(page: Page, act: () => Promise<void>): Promise<void> {
  const posted = page.waitForResponse((response) => response.request().method() === "POST");
  await act();
  await posted;
}

/**
 * A jack's grab handle. The group around it is as wide as the port's label, so
 * clicking the centre of `[data-port-key]` would land next to the jack.
 */
export function jack(page: Page, nodeId: string, portKey: string) {
  return page.locator(`[data-node-key="${nodeId}"] [data-port-key="${portKey}"] [data-port-grip]`);
}

/** Drags one jack onto another, the way someone patches on the canvas. */
export async function dragWire(
  page: Page,
  from: ReturnType<typeof jack>,
  to: ReturnType<typeof jack>,
): Promise<void> {
  await from.scrollIntoViewIfNeeded();
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("a jack was not on screen");

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  // In steps, because the drop target is found by hit testing the moves rather
  // than by the pointer entering the target element.
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await saving(page, () => page.mouse.up());
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
