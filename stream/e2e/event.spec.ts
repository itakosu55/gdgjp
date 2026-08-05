import { expect, test } from "@playwright/test";
import { DEVICES, E2E_PREFIX, EVENT, GEAR_EVENT } from "./seed-data";

test("the seeded event lists its setups and its available gear", async ({ page }) => {
  await page.goto(`/events/${EVENT.id}`);

  await expect(page.getByRole("heading", { name: EVENT.title })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E ハウリング", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: DEVICES[0].name, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// Both of these change GEAR_EVENT's gear list, which nothing else reads.
test.describe("available gear", () => {
  test.describe.configure({ mode: "serial" });

  test("can be taken off the event and put back", async ({ page }) => {
    await page.goto(`/events/${GEAR_EVENT.id}`);
    const chip = page.getByRole("button", { name: DEVICES[5].name, exact: true });

    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  test("is what a setup is allowed to use", async ({ page }) => {
    const mixer = DEVICES[1].name;
    await page.goto(`/events/${GEAR_EVENT.id}`);
    await page.getByRole("button", { name: mixer, exact: true }).click();

    await page.goto(`/events/${GEAR_EVENT.id}/setups/e2e_setup_gear`);
    await expect(
      page.locator('[data-testid="lint-panel"] [data-rule-id="device-not-in-event"]'),
    ).toBeVisible();

    await page.goto(`/events/${GEAR_EVENT.id}`);
    await page.getByRole("button", { name: mixer, exact: true }).click();

    await page.goto(`/events/${GEAR_EVENT.id}/setups/e2e_setup_gear`);
    await expect(
      page.locator('[data-testid="lint-panel"] [data-rule-id="device-not-in-event"]'),
    ).toHaveCount(0);
  });
});

test("an event can be created, then a setup inside it", async ({ page }) => {
  const title = `${E2E_PREFIX}新規イベント`;
  await page.goto("/events");

  await page.locator("#title").fill(title);
  await page.locator("#startsAt").fill("2026-08-22T13:00");
  await page.locator("#venue").fill("E2E 会場");
  await page.getByRole("button", { name: "追加" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // datetime-local is read as JST, so the header must echo the entered time.
  await expect(page.getByText("2026/08/22 13:00")).toBeVisible();

  await page.locator("#setupName").fill("E2E 本番構成");
  await page.getByRole("button", { name: "作成" }).click();

  await expect(page.getByRole("heading", { name: "E2E 本番構成" })).toBeVisible();
  await expect(page.getByTestId("lint-panel")).toContainText("検出された問題はありません");
});
