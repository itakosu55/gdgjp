import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { diagnostic, fillSetupDoc, ruleIds } from "./helpers";
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

  // The cable form used to accept any pair of ports and lean on the linter to
  // complain. It now cannot express an output-to-output cable at all — the case
  // that needed the "except between an app and its host" caveat.
  test("the cable form offers only inputs as a destination", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_editing", "links"));

    const values = await page
      .locator("#linkTo option")
      .evaluateAll((options) => options.map((option) => option.getAttribute("value")));
    expect(values).toContain("n2::ch1");
    expect(values).not.toContain("n2::main_out");
  });

  // Prevention in the form is not detection: a document can also arrive by
  // paste, and will arrive from the AI phase.
  test("a mis-wired cable that arrives another way is still reported", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_editing", "json"));

    const doc = {
      schemaVersion: 1,
      spaces: [],
      nodes: [
        { id: "n1", deviceId: "e2e_dev_mic" },
        { id: "n2", deviceId: "e2e_dev_mixer" },
      ],
      // Output to output between devices with no host relationship.
      links: [{ id: "l_bad", from: ["n1", "out"], to: ["n2", "main_out"] }],
      routing: [],
    };
    await fillSetupDoc(page, JSON.stringify(doc, null, 2));
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    await expect(diagnostic(page, "link-direction")).toBeVisible();
  });
});

/**
 * `links` carries two relationships that behave nothing alike: a cable someone
 * can unplug, and a dropdown in OBS. Read-only, so it shares the howling
 * fixture with everyone else.
 */
test.describe("cables and device selections", () => {
  const section = (page: Page, heading: string) =>
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

  test("are listed in separate tables", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_howling", "links"));

    const cables = section(page, "ケーブル");
    const assignments = section(page, "アプリの入出力割り当て");

    // l3 is a real cable: the mixer's USB send into the PC.
    await expect(cables.getByRole("row").filter({ hasText: "l3" })).toBeVisible();
    // l4 is OBS picking that USB input as its audio source.
    await expect(assignments.getByRole("row").filter({ hasText: "l4" })).toBeVisible();
    await expect(cables.getByRole("row").filter({ hasText: "l4" })).toHaveCount(0);
  });

  test("the assignment form never asks which way round the link goes", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_howling", "links"));

    await expect(page.locator("#assignApp")).toBeVisible();
    await expect(page.locator("#assignHost")).toBeVisible();
    // The caveat the old single form had to carry.
    await expect(page.getByText(/出力 → 出力/)).toHaveCount(0);
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

    await fillSetupDoc(page, "{ not json");
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    await expect(page.getByText("JSON として読み取れません。")).toBeVisible();
  });

  test("rejects JSON that does not match the schema", async ({ page }) => {
    await page.goto(url);

    await fillSetupDoc(page, '{"schemaVersion": 99}');
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

    await fillSetupDoc(page, JSON.stringify(doc));
    await page.getByRole("button", { name: "この内容で置き換える" }).click();

    // A document can arrive from anywhere — another event, a prompt — and the
    // linter must judge it the same way it judges one built in the UI.
    await expect(diagnostic(page, "acoustic-feedback-loop")).toBeVisible();
    expect(await ruleIds(page)).not.toContain("unknown-reference");
  });
});
