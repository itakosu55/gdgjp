import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { diagnostic, fillSetupDoc, formWith, openAddPanel, ruleIds } from "./helpers";
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
    await openAddPanel(page);

    await page.locator("#spaceLabel").fill("E2E メインホール");
    await page.locator("#spaceKind").selectOption("acoustic");
    await formWith(page, "#spaceLabel").getByRole("button", { name: "追加" }).click();

    // The room becomes a group in the tree, exactly as it becomes a frame in
    // the diagram.
    await expect(page.getByRole("link", { name: "E2E メインホール" })).toBeVisible();
  });

  test("adding a mic with no space assigned is flagged", async ({ page }) => {
    await page.goto(url);
    await openAddPanel(page);

    await page.locator("#addDevice").selectOption({ label: "E2E ハンドマイク" });
    await formWith(page, "#addDevice").getByRole("button", { name: "追加" }).click();

    // Without a room, howling cannot be detected at all — hence a warning.
    await expect(diagnostic(page, "space-unassigned")).toBeVisible();
  });

  test("assigning the mic to the space clears the warning", async ({ page }) => {
    // The per-node form is the inspector now, so the node has to be selected.
    await page.goto(setupUrl("e2e_setup_editing", undefined, "n1"));

    const nodeForm = formWith(page, "#space-n1");
    await nodeForm.locator("#space-n1").selectOption({ label: "E2E メインホール" });
    await nodeForm.getByRole("button", { name: "保存" }).click();

    await expect(diagnostic(page, "space-unassigned")).toHaveCount(0);
  });

  test("a cable can be drawn between two devices", async ({ page }) => {
    await page.goto(url);
    await openAddPanel(page);
    await page.locator("#addDevice").selectOption({ label: "E2E ミキサー" });
    await formWith(page, "#addDevice").getByRole("button", { name: "追加" }).click();

    // Wait for the second node's row, not just any text: navigating before the
    // submission lands leaves the link form with nothing to pick.
    await expect(page.locator('[data-node-id="n2"]')).toBeVisible();

    await page.goto(setupUrl("e2e_setup_editing", "cables"));
    await page.locator("#linkFrom").selectOption("n1::out");
    await page.locator("#linkTo").selectOption("n2::ch1");
    await formWith(page, "#linkFrom").getByRole("button", { name: "追加" }).click();

    const row = page.getByRole("row").filter({ hasText: "E2E ハンドマイク" });
    await expect(row).toContainText("E2E ミキサー");
  });

  // The cable form used to accept any pair of ports and lean on the linter to
  // complain. It now cannot express an output-to-output cable at all — the case
  // that needed the "except between an app and its host" caveat.
  test("the cable form offers only inputs as a destination", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_editing", "cables"));

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
    await page.goto(setupUrl("e2e_setup_howling", "cables"));

    const cables = section(page, "ケーブル");
    const assignments = section(page, "アプリの入出力割り当て");

    // l3 is a real cable: the mixer's USB send into the PC.
    await expect(cables.getByRole("row").filter({ hasText: "l3" })).toBeVisible();
    // l4 is OBS picking that USB input as its audio source.
    await expect(assignments.getByRole("row").filter({ hasText: "l4" })).toBeVisible();
    await expect(cables.getByRole("row").filter({ hasText: "l4" })).toHaveCount(0);
  });

  test("the assignment form never asks which way round the link goes", async ({ page }) => {
    await page.goto(setupUrl("e2e_setup_howling", "cables"));

    await expect(page.locator("#assignApp")).toBeVisible();
    await expect(page.locator("#assignHost")).toBeVisible();
    // The caveat the old single form had to carry.
    await expect(page.getByText(/出力 → 出力/)).toHaveCount(0);
  });
});

/**
 * The document itself. It survived the tab cull because it is the interchange
 * format: copy between events, hand-edit, and later read what the AI phase
 * emits — it just moved to the status bar.
 */
test.describe("the JSON view", () => {
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

// The dock is on screen at the same time as the document now, which the old
// tabs made impossible. A stale textarea is worse here than anywhere else: it
// is what 置き換える writes, so it would undo the fix that just landed.
test("the JSON reloads when an edit arrives from the dock", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_json_dock", "json"));
  const textarea = page.locator("textarea[name=doc]");
  await page.waitForLoadState("networkidle");
  expect(JSON.parse(await textarea.inputValue()).routing).toHaveLength(2);

  await page
    .getByRole("button", { name: /この経路を切る/ })
    .first()
    .click();

  await expect.poll(async () => JSON.parse(await textarea.inputValue()).routing.length).toBe(1);
});

/**
 * The inspector is uncontrolled, and `defaultValue` only applies at mount, so a
 * `<select>` React reuses across a re-render keeps the option the *previous*
 * node put there. That is not just a display fault: the leftover value is what
 * 保存 writes, so it silently moves a device into the wrong room.
 */
test.describe("the inspector", () => {
  const at = (selection: string) => setupUrl("e2e_setup_inspector", undefined, selection);

  test("shows the selected node's own 所在, never the one before it", async ({ page }) => {
    await page.goto(at("n1"));
    await expect(page.locator("#space-n1")).toHaveValue("");

    await page.locator('[data-node-id="n2"]').click();
    await expect(page.locator("#space-n2")).toHaveValue("sp2");

    // Room to room, which is the case a single-room setup cannot catch.
    await page.locator('[data-node-id="n3"]').click();
    await expect(page.locator("#space-n3")).toHaveValue("sp1");

    await page.locator('[data-node-id="n1"]').click();
    await expect(page.locator("#space-n1")).toHaveValue("");
  });

  test("shows the selected node's own ホスト PC", async ({ page }) => {
    await page.goto(at("n1"));
    await expect(page.locator("#host-n1")).toHaveValue("");

    await page.locator('[data-node-id="n5"]').click();
    await expect(page.locator("#host-n5")).toHaveValue("n4");

    await page.locator('[data-node-id="n1"]').click();
    await expect(page.locator("#host-n1")).toHaveValue("");
  });
});

/**
 * The shell itself. The claim being tested is that one implementation covers
 * every width: the same tree, inspector and dock, reflowed by two container
 * queries rather than by a second narrow-screen code path.
 */
test.describe("the editor shell", () => {
  test("keeps the tree and the inspector on a wide screen", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_howling", "diagram", "n2"));

    await expect(page.locator('[data-node-id="n2"]')).toBeVisible();
    await expect(page.locator("#space-n2")).toBeVisible();
    await expect(page.getByTestId("lint-panel")).toBeVisible();
  });

  test("folds both panels into drawers on a phone without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(setupUrl("e2e_setup_howling", "diagram", "n2"));

    // Same DOM: the inspector is still rendered, just translated off screen.
    await expect(page.locator("#space-n2")).toBeAttached();
    await expect(page.locator("#space-n2")).not.toBeInViewport();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "インスペクタを開く" }).click();
    await expect(page.locator("#space-n2")).toBeInViewport();
  });
});
