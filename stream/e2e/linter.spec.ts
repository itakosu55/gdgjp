import { expect, test } from "@playwright/test";
import { diagnostic, ruleIds } from "./helpers";
import { setupUrl } from "./seed-data";

/**
 * The reason the app exists. Each fixture is a wiring mistake that has actually
 * cost a GDG event, driven through the real editor rather than the unit tests.
 *
 * Read-only checks and mutating ones use separate seeded setups so the suite
 * stays fully parallel and order-independent.
 */

test.describe("howling", () => {
  test("reports the loop with the path through the gear", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_howling"));

    const found = diagnostic(page, "acoustic-feedback-loop");
    await expect(found).toHaveAttribute("data-severity", "critical");
    await expect(found).toContainText("E2E ハンドマイク");
    await expect(found).toContainText("E2E 会場スピーカー");
  });

  test("cutting the MAIN send clears it without silencing the stream", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_howling_fix"));
    await expect(diagnostic(page, "acoustic-feedback-loop")).toBeVisible();

    await page
      .getByRole("button", { name: /この経路を切る/ })
      .first()
      .click();

    await expect(diagnostic(page, "acoustic-feedback-loop")).toHaveCount(0);
    // ch1 still reaches the USB bus, so the fix must not create a silent stream.
    expect(await ruleIds(page)).not.toContain("no-audio-to-stream");

    // And the matrix must show exactly that: MAIN off, USB still on.
    await page.goto(setupUrl("e2e_setup_howling_fix", "routing"));
    await expect(page.getByRole("button", { name: "CH1 → MAIN" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByRole("button", { name: "CH1 → USB" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("remote participant echo", () => {
  test("reports an electrical Mix-Minus violation", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_mixminus"));

    const found = diagnostic(page, "remote-echo-electrical");
    await expect(found).toHaveAttribute("data-severity", "critical");
    await expect(found).toContainText("Mix-Minus");
    // It is electrical, not a room bleed — the fix differs, so the id must too.
    expect(await ruleIds(page)).not.toContain("remote-echo-acoustic");
  });

  test("clears once the USB return is taken off the USB send bus", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_mixminus_fix"));
    await expect(diagnostic(page, "remote-echo-electrical")).toBeVisible();

    await page
      .getByRole("button", { name: /この経路を切る/ })
      .first()
      .click();

    await expect(diagnostic(page, "remote-echo-electrical")).toHaveCount(0);
  });
});

test("reports a loop closed through a second join of the same meeting", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_transport"));

  const found = diagnostic(page, "transport-echo-loop");
  await expect(found).toHaveAttribute("data-severity", "critical");
  // The presenter's own laptop is the machine that appears on no patch sheet,
  // and naming it is the whole point of the rule.
  await expect(found).toContainText("E2E 内蔵マイク");
  await expect(found).toContainText("E2E 会場スピーカー");
  // Not oscillation in the room: the two must not both be reported.
  await expect(ruleIds(page)).resolves.not.toContain("acoustic-feedback-loop");
});

test("reports a stream with no audio reaching it", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_silent"));

  await expect(diagnostic(page, "no-audio-to-stream")).toHaveAttribute("data-severity", "critical");
});

test("a setup with no problems says so", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_clean"));

  await expect(page.getByTestId("lint-panel")).toContainText("検出された問題はありません");
});

test("the diagram stays a sane width on a setup that howls", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_howling", "diagram"));

  const svg = page.locator('svg[aria-label="信号フロー図"]');
  await expect(svg).toBeVisible();
  // Ranking used to relax around the loop and add a column per pass, which blew
  // a six-node diagram out to ~5000px.
  const width = Number(await svg.getAttribute("width"));
  expect(width).toBeLessThan(1500);
});

// The presenter's laptop is the machine that closes the loop in this fixture,
// and it never used to look like a machine: its Meet window was pinned over
// with the mics, several columns from the laptop running it.
test("the diagram draws each app inside its machine and each machine in its room", async ({
  page,
}) => {
  await page.goto(setupUrl("e2e_setup_transport", "diagram"));

  const laptop = page.locator('[data-node-key="n6"]').locator("rect").first();
  const join = page.locator('[data-node-key="n8"]');
  await expect(join).toHaveAttribute("data-parent-key", "n6");

  const room = await page.locator("[data-frame-key]").first().locator("rect").boundingBox();
  const machine = await laptop.boundingBox();
  const app = await join.locator("rect").first().boundingBox();
  if (!room || !machine || !app) throw new Error("the diagram did not render");

  const inside = (outer: typeof room, inner: typeof room) =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;

  expect(inside(machine, app)).toBe(true);
  expect(inside(room, machine)).toBe(true);
});
