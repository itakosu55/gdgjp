import { expect, test } from "@playwright/test";
import { E2E_PREFIX } from "./seed-data";

test("the migration-seeded catalog is not empty", async ({ page }) => {
  await page.goto("/models");

  const row = page.getByRole("row").filter({ hasText: "MG10XU" });
  await expect(row).toContainText("ミキサー");
});

test("a mixer's detail page shows its ports and its default routing matrix", async ({ page }) => {
  await page.goto("/models");
  await page.getByRole("link", { name: /MG10XU/ }).click();

  await expect(page.getByRole("heading", { name: /MG10XU/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "ch1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "CH1 → MAIN" })).toBeVisible();
});

test("Meet is catalogued as none, never passthrough", async ({ page }) => {
  await page.goto("/models");

  // A conferencing app that passes its input to its output invents an echo
  // loop, so this is the one catalog value the linter's correctness rests on.
  const row = page.getByRole("row").filter({ hasText: "Google Meet" });
  await expect(row).toContainText("none");
  await expect(row).toContainText("会議ソフト");
});

test("a model can be created and given a bus, a port and a default route", async ({ page }) => {
  const name = `${E2E_PREFIX}テストミキサー`;
  await page.goto("/models");

  await page.locator("#name").fill(name);
  await page.locator("#category").selectOption("mixer");
  await page.locator("#internalRouting").selectOption("matrix");
  await page.getByRole("button", { name: "追加" }).click();

  await expect(page.getByRole("heading", { name })).toBeVisible();

  await page.locator("#busKey").fill("main");
  await page.locator("#busLabel").fill("MAIN");
  await page.locator("#busKind").selectOption("main");
  await page.getByRole("button", { name: "バスを追加" }).click();

  await page.locator("#portKey").fill("ch1");
  await page.locator("#portLabel").fill("CH1");
  await page.locator("#direction").selectOption("in");
  await page.getByRole("button", { name: "端子を追加" }).click();

  await expect(page.getByRole("cell", { name: "ch1", exact: true })).toBeVisible();

  // The matrix only appears once the model has both a bus and an input.
  const cell = page.getByRole("button", { name: "CH1 → MAIN" });
  await expect(cell).toHaveText("");
  await cell.click();
  await expect(page.getByRole("button", { name: "CH1 → MAIN" })).toHaveText("✓");
});
