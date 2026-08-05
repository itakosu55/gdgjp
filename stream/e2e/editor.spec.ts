import { expect, test } from "@playwright/test";
import { diagnostic, ruleIds } from "./helpers";
import { setupUrl } from "./seed-data";

/**
 * Builds a rig from an empty document the way someone would on the day, and
 * checks the linter reacts at each step. Serial because each step depends on
 * the one before; it has its own seeded setup so nothing else is affected.
 */
test.describe("building a setup from scratch", () => {
  test.describe.configure({ mode: "serial" });

  const url = setupUrl("e2e_setup_editing");

  test("a space can be added", async ({ page }) => {
    await page.goto(url);

    await page.locator("#spaceLabel").fill("E2E メインホール");
    await page.locator("#spaceKind").selectOption("acoustic");
    await page
      .locator("form")
      .filter({ has: page.locator("#spaceLabel") })
      .getByRole("button", { name: "追加" })
      .click();

    await expect(page.getByText("E2E メインホール")).toBeVisible();
  });

  test("adding a mic with no space assigned is flagged", async ({ page }) => {
    await page.goto(url);

    await page.locator("#addDevice").selectOption({ label: "E2E ハンドマイク" });
    await page
      .locator("form")
      .filter({ has: page.locator("#addDevice") })
      .getByRole("button", { name: "追加" })
      .click();

    // Without a room, howling cannot be detected at all — hence a warning.
    await expect(diagnostic(page, "space-unassigned")).toBeVisible();
  });

  test("assigning the mic to the space clears the warning", async ({ page }) => {
    await page.goto(url);

    const nodeForm = page.locator("form").filter({ has: page.locator("#space-n1") });
    await nodeForm.locator("#space-n1").selectOption({ label: "E2E メインホール" });
    await nodeForm.getByRole("button", { name: "保存" }).click();

    await expect(diagnostic(page, "space-unassigned")).toHaveCount(0);
  });

  test("a cable can be drawn between two devices", async ({ page }) => {
    await page.goto(url);
    await page.locator("#addDevice").selectOption({ label: "E2E ミキサー" });
    await page
      .locator("form")
      .filter({ has: page.locator("#addDevice") })
      .getByRole("button", { name: "追加" })
      .click();

    // Wait for the second node's card, not just any text: navigating before the
    // submission lands leaves the link form with nothing to pick.
    await expect(page.locator("#label-n2")).toBeVisible();

    await page.goto(setupUrl("e2e_setup_editing", "links"));
    await page.locator("#linkFrom").selectOption("n1::out");
    await page.locator("#linkTo").selectOption("n2::ch1");
    await page.getByRole("button", { name: "追加" }).click();

    const row = page.getByRole("row").filter({ hasText: "E2E ハンドマイク" });
    await expect(row).toContainText("E2E ミキサー");
  });

  test("a mis-wired cable is reported rather than silently accepted", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_editing", "links"));

    // Output to output between devices with no host relationship.
    await page.locator("#linkFrom").selectOption("n1::out");
    await page.locator("#linkTo").selectOption("n2::main_out");
    await page.getByRole("button", { name: "追加" }).click();

    await expect(diagnostic(page, "link-direction")).toBeVisible();
  });
});

test.describe("the JSON tab", () => {
  test.describe.configure({ mode: "serial" });

  const url = setupUrl("e2e_setup_json", "json");

  test("shows the document without any coordinates in it", async ({ page }) => {
    await page.goto(url);

    const value = await page.locator("textarea[name=doc]").inputValue();
    const parsed = JSON.parse(value);
    expect(parsed.schemaVersion).toBe(1);
    // No coordinates is the property the whole AI-proposal plan rests on.
    expect(value).not.toContain('"x"');
    expect(value).not.toContain('"position"');
  });

  test("rejects text that is not JSON", async ({ page }) => {
    await page.goto(url);

    await page.locator("textarea[name=doc]").fill("{ not json");
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    await expect(page.getByText("JSON として読み取れません。")).toBeVisible();
  });

  test("rejects JSON that does not match the schema", async ({ page }) => {
    await page.goto(url);

    await page.locator("textarea[name=doc]").fill('{"schemaVersion": 99}');
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    await expect(page.getByText(/スキーマに適合しません/)).toBeVisible();
  });

  test("accepts a pasted document and re-lints it", async ({ page }) => {
    await page.goto(url);

    const doc = {
      schemaVersion: 1,
      spaces: [{ id: "sp1", kind: "acoustic", label: "貼り付けホール" }],
      nodes: [
        { id: "n1", deviceId: "e2e_dev_mic", spaceId: "sp1" },
        { id: "n2", deviceId: "e2e_dev_mixer" },
        { id: "n3", deviceId: "e2e_dev_speaker", spaceId: "sp1" },
      ],
      links: [
        { id: "l1", from: ["n1", "out"], to: ["n2", "ch1"] },
        { id: "l2", from: ["n2", "main_out"], to: ["n3", "in"] },
      ],
      routing: [{ nodeId: "n2", inPort: "ch1", bus: "main" }],
    };

    await page.locator("textarea[name=doc]").fill(JSON.stringify(doc));
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    // A document can arrive from anywhere — another event, a prompt — and the
    // linter must judge it the same way it judges one built in the UI.
    await expect(diagnostic(page, "acoustic-feedback-loop")).toBeVisible();
    expect(await ruleIds(page)).not.toContain("unknown-reference");
  });
});
