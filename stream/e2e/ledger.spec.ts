import { expect, test } from "@playwright/test";
import { DEVICES, E2E_PREFIX } from "./seed-data";

test("the seeded gear is listed with its model and category", async ({ page }) => {
  await page.goto("/devices");

  const row = page.getByRole("row").filter({ hasText: DEVICES[1].name });
  await expect(row).toContainText("MG10XU");
  await expect(row).toContainText("ミキサー");
});

test("a device can be added and removed", async ({ page }) => {
  const name = `${E2E_PREFIX}追加テスト機材`;
  await page.goto("/devices");

  await page.locator("#modelId").selectOption({ label: "Shure SM58" });
  await page.locator("#name").fill(name);
  await page.locator("#identifier").fill("赤シール");
  await page.locator("#ownerNote").fill("E2E 備品");
  await page.getByRole("button", { name: "追加" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("赤シール");

  await row.getByRole("button", { name: "削除" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});

test("a blank name is refused by the server, not just the browser", async ({ page }) => {
  await page.goto("/devices");

  // Whitespace satisfies the HTML `required` check, so this reaches the action.
  await page.locator("#modelId").selectOption({ label: "Shure SM58" });
  await page.locator("#name").fill("   ");
  await page.getByRole("button", { name: "追加" }).click();

  await expect(page.getByText("機材名は必須です。")).toBeVisible();
});
