import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  diagnostic,
  dragWire,
  fillSetupDoc,
  formWith,
  jack,
  openAddPanel,
  ruleIds,
  saving,
} from "./helpers";
import { setupUrl } from "./seed-data";

/**
 * Builds a rig from an empty document the way someone would on the day, and
 * checks the linter reacts at each step. Serial because each step depends on
 * the one before; it has its own seeded setup so nothing else is affected.
 *
 * Every edit goes through `saving`, because each step here is a *precondition*
 * of the next one. The linter now runs in the browser, so a finding appears
 * while the write is still in the air — enough to assert on, not enough to be
 * there when the next test loads the page.
 */
test.describe("building a setup from scratch", () => {
  test.describe.configure({ mode: "serial" });

  const url = setupUrl("e2e_setup_editing");

  test("a space can be added", async ({ page }) => {
    await page.goto(url);
    await openAddPanel(page);

    await page.locator("#spaceLabel").fill("E2E メインホール");
    await page.locator("#spaceKind").selectOption("acoustic");
    await saving(page, () =>
      formWith(page, "#spaceLabel").getByRole("button", { name: "追加" }).click(),
    );

    // The room becomes a group in the tree, exactly as it becomes a frame in
    // the diagram.
    await expect(page.getByRole("link", { name: "E2E メインホール" })).toBeVisible();
  });

  test("adding a mic with no space assigned is flagged", async ({ page }) => {
    await page.goto(url);
    await openAddPanel(page);

    await page.locator("#addDevice").selectOption({ label: "E2E ハンドマイク" });
    await saving(page, () =>
      formWith(page, "#addDevice").getByRole("button", { name: "追加" }).click(),
    );

    // Without a room, howling cannot be detected at all — hence a warning.
    await expect(diagnostic(page, "space-unassigned")).toBeVisible();
  });

  test("assigning the mic to the space clears the warning", async ({ page }) => {
    // The per-node form is the inspector now, so the node has to be selected.
    await page.goto(setupUrl("e2e_setup_editing", undefined, "n1"));

    const nodeForm = formWith(page, "#space-n1");
    await nodeForm.locator("#space-n1").selectOption({ label: "E2E メインホール" });
    await saving(page, () => nodeForm.getByRole("button", { name: "保存" }).click());

    await expect(diagnostic(page, "space-unassigned")).toHaveCount(0);
  });

  test("a cable can be drawn between two devices", async ({ page }) => {
    await page.goto(url);
    await openAddPanel(page);
    await page.locator("#addDevice").selectOption({ label: "E2E ミキサー" });
    await saving(page, () =>
      formWith(page, "#addDevice").getByRole("button", { name: "追加" }).click(),
    );
    await expect(page.locator('[data-node-id="n2"]')).toBeVisible();

    await page.goto(setupUrl("e2e_setup_editing", "cables"));
    await page.locator("#linkFrom").selectOption("n1::out");
    await page.locator("#linkTo").selectOption("n2::ch1");
    await saving(page, () =>
      formWith(page, "#linkFrom").getByRole("button", { name: "追加" }).click(),
    );

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
    // OBS picking that USB input as its audio source is not a link at all any
    // more, so it has no id to find it by — the app jack names it (§12.4.1).
    await expect(assignments.getByRole("row").filter({ hasText: "音声ソース" })).toBeVisible();
    await expect(cables.getByRole("row").filter({ hasText: "音声ソース" })).toHaveCount(0);
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
 * The picture is the wiring surface now, not a report of one.
 *
 * A cable and a device selection are drawn the same way and told apart by
 * geometry alone — across the faces is a cable, along one face is an app
 * picking a device on the computer under it — which is the same rule
 * `buildAssignmentEdges` uses to derive the direction, so neither the drag nor
 * the form ever has to ask which way round it goes.
 */
test.describe("wiring on the canvas", () => {
  test("dragging an output onto an input draws a cable", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_wiring", "diagram"));
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-link-id]")).toHaveCount(0);

    await dragWire(page, jack(page, "n1", "out"), jack(page, "n2", "ch1"));

    // The line appears in the picture, which is the thing being tested: the
    // document was re-laid out in the browser rather than fetched back.
    await expect(page.locator('[data-link-id="l1"]')).toBeVisible();
    await page.goto(setupUrl("e2e_setup_wiring", "cables"));
    const row = page.getByRole("row").filter({ hasText: "E2E ハンドマイク" });
    await expect(row).toContainText("E2E ミキサー");
  });

  test("dragging along one face assigns the app a device on its host", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_assign", "diagram"));
    await page.waitForLoadState("networkidle");

    // Two inputs. As a cable this would be nonsense; between OBS and the PC it
    // runs on it is which capture device OBS is listening to.
    await dragWire(page, jack(page, "n4", "audio_src:1"), jack(page, "n3", "usb_in"));

    await page.goto(setupUrl("e2e_setup_assign", "cables"));
    const assignments = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "アプリの入出力割り当て", exact: true }) });
    // No id column and no arrow: a selection is named by the app jack that made
    // it, and its direction is derived rather than stored (§12.4.1).
    const row = assignments.getByRole("row").filter({ hasText: "音声ソース" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("USB");
  });

  test("clicking a device selects it in the inspector", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_inspector", "diagram"));

    await page.locator('[data-node-key="n2"]').click();

    await expect(page).toHaveURL(/sel=n2/);
    await expect(page.locator("#space-n2")).toHaveValue("sp2");
  });

  // A room is two shapes at once — the dashed box for the air in it and the
  // frame round everything standing in it — and both have to mean the room.
  test("clicking a room's frame selects the room", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_inspector", "diagram"));

    await page.getByRole("button", { name: "E2E ホール A を選択" }).click();

    await expect(page).toHaveURL(/sel=space%3Asp1/);
    await expect(page.getByRole("heading", { name: "E2E ホール A" })).toBeVisible();
  });
});

/**
 * The linter and the layout run in the browser now, so an edit changes the
 * picture without a navigation. What that buys is everything a navigation used
 * to throw away, and the selection is the part someone notices immediately:
 * acting on a finding used to clear whatever was open in the inspector.
 */
test("applying a fix from the dock keeps the page where it was", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(setupUrl("e2e_setup_live", "diagram", "n2"));
  await page.waitForLoadState("networkidle");
  await expect(diagnostic(page, "acoustic-feedback-loop")).toBeVisible();

  await page
    .getByRole("button", { name: /この経路を切る/ })
    .first()
    .click();

  await expect(diagnostic(page, "acoustic-feedback-loop")).toHaveCount(0);
  // Same URL, same selection, same view — none of which survived a navigation.
  await expect(page).toHaveURL(/view=diagram/);
  await expect(page).toHaveURL(/sel=n2/);
  await expect(page.locator("#space-n2")).toBeVisible();
});

/**
 * §11.6: what people actually do on the day is mute the presenter's mic and
 * leave their sound on. A node-wide isolated cannot say that now the laptop is
 * one node carrying both transducers, so the inspector mutes a single jack.
 */
test("muting one jack of the presenter's laptop clears the transport echo", async ({ page }) => {
  await page.goto(setupUrl("e2e_setup_mute", undefined, "n6"));
  await expect(diagnostic(page, "transport-echo-loop")).toBeVisible();

  const form = formWith(page, "#space-n6");
  const mic = form.getByRole("checkbox", { name: "内蔵マイク" });
  const speaker = form.getByRole("checkbox", { name: "内蔵スピーカー" });
  await expect(speaker).not.toBeChecked();

  await mic.check();
  await saving(page, () => form.getByRole("button", { name: "保存" }).click());

  await expect(diagnostic(page, "transport-echo-loop")).toHaveCount(0);
  // The other face is untouched: the presenter can still hear the meeting.
  await expect(speaker).not.toBeChecked();
  await expect(mic).toBeChecked();
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

/**
 * A broadcast app's mixer has one row per source, and the sources are chosen on
 * the day. This is §12's acceptance condition driven through the real editor:
 * the meeting is monitored into the room and the hall mic is not, which with a
 * single 音声ソース row could not be written down at all.
 */
test.describe("a broadcast app's sources", () => {
  test("keeps the hall mic off the monitor bus while the meeting is on it", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_sources", "routing", "n5"));

    const mic = page.getByRole("row").filter({ hasText: "E2E 会場マイク" });
    await expect(mic.getByRole("button", { name: /PROGRAM$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(mic.getByRole("button", { name: /MONITOR$/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The browser source is two rows under one name; the audio half comes
    // first, and it is the one carrying the meeting into the room.
    const meet = page.getByRole("row").filter({ hasText: "E2E Meet" }).first();
    await expect(meet.getByRole("button", { name: /MONITOR$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Which is the whole point: the monitor return no longer closes a loop.
    await expect(ruleIds(page)).resolves.not.toContain("stream-monitor-loop");
  });

  test("adding a source gives the mixer a new row of its own", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_sources", "routing", "n5"));

    const sources = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "ソース", exact: true }) });
    await sources.locator("#source-n5").selectOption("audio_src");

    await saving(page, () => sources.getByRole("button", { name: "追加" }).click());

    // It arrives already on PROGRAM, the default its template carries, and the
    // rows that were there are untouched.
    const added = page.getByRole("row").filter({ hasText: "音声ソース" });
    await expect(added.getByRole("button", { name: /PROGRAM$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(added.getByRole("button", { name: /MONITOR$/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const mic = page.getByRole("row").filter({ hasText: "E2E 会場マイク" });
    await expect(mic.getByRole("button", { name: /MONITOR$/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("a video is reported as reaching the stream and nobody else", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_sources", "routing", "n5"));

    const sources = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "ソース", exact: true }) });
    // One choice, not two: a video's picture and its sound are one source.
    await sources.locator("#source-n5").selectOption("media_audio");

    await saving(page, () => sources.getByRole("button", { name: "追加" }).click());

    // Nothing is plugged into a video file, so before §12.5 the linter had no
    // way to ask where its sound went. Now it says: PROGRAM and nowhere else.
    await expect(
      diagnostic(page, "source-not-reaching-remote").filter({ hasText: "メディア音声" }),
    ).toBeVisible();
  });

  test("a browser source with only one half on PROGRAM is reported, and the cell fixes it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(setupUrl("e2e_setup_sources", "routing", "n5"));

    // The meeting is monitored into the room but its picture was never put on
    // the stream. Both halves are called "E2E Meet", so the finding has to say
    // which medium it means.
    await expect(
      diagnostic(page, "partial-source").filter({ hasText: "E2E Meetの映像" }),
    ).toBeVisible();

    const video = page.getByRole("row").filter({ hasText: "E2E Meet" }).nth(1);
    await saving(page, () => video.getByRole("button", { name: /PROGRAM$/ }).click());

    await expect(diagnostic(page, "partial-source")).toHaveCount(0);
  });
});
