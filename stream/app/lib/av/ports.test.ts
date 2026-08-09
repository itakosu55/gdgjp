import { describe, expect, it } from "vitest";
import { MODELS } from "./fixtures";
import { initialPorts, newSource, resolvePorts, sourceGroup, unknownTemplates } from "./ports";
import type { SetupNode } from "./schema";
import type { DeviceModel } from "./types";

const obs = modelOf("m_obs");
const mixer = modelOf("m_mixer");

function modelOf(id: string): DeviceModel {
  const found = MODELS.find((model) => model.id === id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
}

function node(partial: Partial<SetupNode> = {}): SetupNode {
  return { id: "n1", modelId: "m_obs", ...partial };
}

describe("resolvePorts", () => {
  it("leaves a model whose jacks are all real exactly as it is", () => {
    expect(resolvePorts(mixer, { id: "n1", deviceId: "d_mixer" })).toBe(mixer.ports);
  });

  // The catalog is the authority on what an OBS is, and a template is not a
  // jack: nothing can be plugged into 音声ソース itself.
  it("drops a template that the setup has no source for", () => {
    expect(resolvePorts(obs, node()).map((port) => port.key)).toEqual([
      "stream_out",
      "program_video",
      "monitor_out",
    ]);
  });

  it("gives each source its own port, inheriting everything but the name", () => {
    const ports = resolvePorts(
      obs,
      node({
        ports: [
          { key: "audio_src:1", template: "audio_src", label: "登壇者マイク" },
          { key: "audio_src:2", template: "audio_src", label: "会場BGM" },
        ],
      }),
    );

    const sources = ports.filter((port) => port.direction === "in");
    expect(sources.map((port) => [port.key, port.label])).toEqual([
      ["audio_src:1", "登壇者マイク"],
      ["audio_src:2", "会場BGM"],
    ]);
    expect(sources.every((port) => port.signal === "audio_digital")).toBe(true);
    // An instance is a jack, not another template to expand.
    expect(sources.every((port) => port.expandable === false)).toBe(true);
  });

  it("keeps a nameless source readable by falling back to the template's name", () => {
    const ports = resolvePorts(
      obs,
      node({ ports: [{ key: "video_src:1", template: "video_src" }] }),
    );
    expect(ports.find((port) => port.key === "video_src:1")?.label).toBe("映像ソース");
  });

  /**
   * Sources stand where their template stood, so the mixer rows come before the
   * outputs the way the OBS window does — and the diagram, the matrix and the
   * wiring form all read one order.
   */
  it("puts the sources where the template was, ahead of the fixed outputs", () => {
    const ports = resolvePorts(
      obs,
      node({
        ports: [
          { key: "video_src:1", template: "video_src" },
          { key: "audio_src:1", template: "audio_src" },
        ],
      }),
    );

    expect(ports.map((port) => port.key)).toEqual([
      "audio_src:1",
      "video_src:1",
      "stream_out",
      "program_video",
      "monitor_out",
    ]);
  });

  // A hand-edited document is a real editing surface (the JSON view), and a
  // second port under an existing key would be one the links and the matrix
  // could not tell apart.
  it("refuses to let a source shadow a jack the model already has", () => {
    const ports = resolvePorts(
      obs,
      node({ ports: [{ key: "monitor_out", template: "audio_src" }] }),
    );
    expect(ports.filter((port) => port.key === "monitor_out")).toHaveLength(1);
    expect(ports.find((port) => port.key === "monitor_out")?.direction).toBe("out");
  });

  it("names a source whose kind the model does not declare", () => {
    expect(unknownTemplates(obs, node({ ports: [{ key: "x:1", template: "x" }] }))).toEqual(["x"]);
    expect(
      unknownTemplates(obs, node({ ports: [{ key: "audio_src:1", template: "audio_src" }] })),
    ).toEqual([]);
  });
});

describe("adding a source", () => {
  // §9.3: the ordinary case must not cost extra data entry, and an OBS whose
  // mixer has no rows at all is not a document anyone wanted.
  it("starts a broadcast app with one audio source and one video source", () => {
    expect(initialPorts(obs)).toEqual([
      { key: "audio_src:1", template: "audio_src" },
      { key: "video_src:1", template: "video_src" },
    ]);
  });

  it("does not invent a browser source nobody asked for", () => {
    expect(initialPorts(obs).some((port) => port.template.startsWith("browser"))).toBe(false);
  });

  it("counts on from the highest number already used", () => {
    const next = newSource(obs, node({ ports: initialPorts(obs) }), "audio_src");
    expect(next).toEqual([{ key: "audio_src:2", template: "audio_src" }]);
  });

  /**
   * A browser source is a picture and a sound. They stay two ports — "the video
   * is on the stream but its audio is not" is the commonest browser-source
   * accident and one merged port hides it — but nobody adds them one at a time.
   */
  it("adds both halves of a browser source in one act, under one id", () => {
    const created = newSource(obs, node(), "browser_audio");

    expect(created.map((port) => port.template)).toEqual(["browser_audio", "browser_video"]);
    expect(new Set(created.map((port) => port.sourceId)).size).toBe(1);
    expect(created[0]?.sourceId).toBeDefined();
  });

  it("gives a second browser source its own id", () => {
    const first = newSource(obs, node(), "browser_audio");
    const second = newSource(obs, node({ ports: first }), "browser_audio");
    expect(second[0]?.sourceId).not.toBe(first[0]?.sourceId);
    expect(second.map((port) => port.key)).toEqual(["browser_audio:2", "browser_video:2"]);
  });

  it("refuses a jack that is not a template", () => {
    expect(newSource(obs, node(), "monitor_out")).toEqual([]);
  });
});

describe("sourceGroup", () => {
  const withBoth = node({
    ports: [
      { key: "audio_src:1", template: "audio_src" },
      { key: "browser_audio:1", template: "browser_audio", sourceId: "s1" },
      { key: "browser_video:1", template: "browser_video", sourceId: "s1" },
    ],
  });

  it("takes both halves of a browser source together", () => {
    expect(sourceGroup(withBoth, "browser_video:1")).toEqual([
      "browser_audio:1",
      "browser_video:1",
    ]);
  });

  it("takes a plain source on its own", () => {
    expect(sourceGroup(withBoth, "audio_src:1")).toEqual(["audio_src:1"]);
  });

  it("says nothing about a source that is not there", () => {
    expect(sourceGroup(withBoth, "audio_src:9")).toEqual([]);
  });
});
