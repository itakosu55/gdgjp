import { z } from "zod";
import { SPACE_KINDS } from "./types";

/**
 * The setup document — the single source of truth for one wiring configuration.
 *
 * Two properties are load-bearing and should survive any refactor:
 *
 * 1. **No coordinates.** Diagrams are laid out automatically on every render.
 *    A future AI proposal emits this document and it becomes a diagram with no
 *    extra work; nothing has to invent or reconcile positions.
 * 2. **Self-contained.** Everything the linter needs beyond the device catalog
 *    lives here, so the document can be exported to the OBS extension, pasted
 *    into a prompt, or hand-edited in the JSON tab.
 */

const id = z.string().min(1).max(64);

export const spaceSchema = z.object({
  id,
  /**
   * `transport` is an online meeting. Adding it widens the enum without
   * invalidating any document that already exists.
   */
  kind: z.enum(SPACE_KINDS),
  label: z.string().min(1).max(120),
  /**
   * Identifies the *physical* space. Unused today. When simultaneous tracks
   * split a setup into several documents, spaces sharing a `venueKey` are the
   * same room, which is the only way cross-track acoustic coupling stays
   * detectable without giving up the document's self-containment.
   */
  venueKey: z.string().min(1).max(64).optional(),
  /**
   * `venueKey` for meetings: two transport spaces sharing one are the same
   * meeting. Also unused today, and there for the same reason — "room A's setup
   * and room B's setup are joined to the same Meet URL" is satellite streaming,
   * and it is the first thing needed once documents split per track.
   */
  meetingKey: z.string().min(1).max(64).optional(),
});

export const setupNodeSchema = z
  .object({
    id,
    /** References `devices.id` — a physical unit in the shared 機材台帳. */
    deviceId: id.optional(),
    /**
     * References `device_models.id` directly, for software. Software is not a
     * physical unit: putting "Meet #1" and "Meet #2" in the ledger is nonsense,
     * and sharing one ledger row between two joins would make the future
     * double-booking rule fire on it. See design doc §9.6.
     */
    modelId: id.optional(),
    /** Overrides the device name for this setup ("登壇者ハンドマイク"). */
    label: z.string().min(1).max(120).optional(),
    /**
     * Where this node is: the room it stands in, or for a join, the meeting it
     * is in.
     *
     * For a category that couples to a space — mics, speakers, cameras,
     * displays, joins — this is also what it couples to, and leaving it blank
     * is what `space-unassigned` reports. For everything else the graph ignores
     * it, because a mixer emits into no room and picks nothing up out of one.
     * It is still worth filling in: a mixer standing in the hall is a fact
     * about the hall, and the diagram draws each room round what is in it.
     */
    spaceId: id.optional(),
    /**
     * `isolated` suppresses space coupling for the whole node: headsets,
     * in-ears, stream-only monitors. It is the shorthand for "every jack", and
     * for a headset mic that is exactly right.
     */
    coupling: z.enum(["open", "isolated"]).optional(),
    /**
     * Jacks muted one at a time, by port key.
     *
     * Once a laptop is one node with a built-in mic and a built-in speaker on
     * it, muting the node is too blunt: what actually happens on the day is
     * "mute the presenter's mic but let them hear", and the same is true of a
     * speakerphone. §4.3 requires that a fix the linter offers be an operation
     * a person can really perform, so the mute has to be per jack.
     */
    isolatedPorts: z.array(z.string().min(1).max(64)).optional(),
    /** Set on software nodes (OBS, Meet) to the computer node they run on. */
    hostNodeId: id.optional(),
  })
  .refine((node) => Boolean(node.deviceId) !== Boolean(node.modelId), {
    message: "deviceId か modelId のいずれか一方が必要です",
  });

/** `[nodeId, portKey]`. */
export const portRefSchema = z.tuple([id, z.string().min(1).max(64)]);

export const linkSchema = z.object({
  id,
  from: portRefSchema,
  to: portRefSchema,
});

/**
 * One `true` cell of a device's (input × bus) routing matrix. Only enabled
 * cells are listed. Gain, EQ, pan and fader values are deliberately absent —
 * cycle detection needs "does this signal reach that bus", never a dB value.
 */
export const routeSchema = z.object({
  nodeId: id,
  inPort: z.string().min(1).max(64),
  bus: z.string().min(1).max(64),
});

export const setupDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    spaces: z.array(spaceSchema).default([]),
    nodes: z.array(setupNodeSchema).default([]),
    links: z.array(linkSchema).default([]),
    routing: z.array(routeSchema).default([]),
    notes: z.string().max(4000).optional(),
  })
  .superRefine((doc, ctx) => {
    // Duplicate ids would silently collapse graph vertices, so they are a
    // document integrity error rather than a lint finding. Dangling references
    // are the opposite: the linter reports them so the editor keeps working.
    for (const [field, items] of [
      ["spaces", doc.spaces],
      ["nodes", doc.nodes],
      ["links", doc.links],
    ] as const) {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            path: [field, index, "id"],
            message: `duplicate id: ${item.id}`,
          });
        }
        seen.add(item.id);
      }
    }
  });

export type Space = z.infer<typeof spaceSchema>;
export type SetupNode = z.infer<typeof setupNodeSchema>;
export type PortRef = z.infer<typeof portRefSchema>;
export type SetupLink = z.infer<typeof linkSchema>;
export type SetupRoute = z.infer<typeof routeSchema>;
export type SetupDoc = z.infer<typeof setupDocSchema>;

export const EMPTY_SETUP_DOC: SetupDoc = {
  schemaVersion: 1,
  spaces: [],
  nodes: [],
  links: [],
  routing: [],
};

export function parseSetupDoc(value: unknown): SetupDoc {
  return setupDocSchema.parse(value);
}

export function safeParseSetupDoc(value: unknown) {
  return setupDocSchema.safeParse(value);
}
