import { z } from "zod";

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
  kind: z.enum(["acoustic", "visual"]),
  label: z.string().min(1).max(120),
  /**
   * Identifies the *physical* space. Unused today. When simultaneous tracks
   * split a setup into several documents, spaces sharing a `venueKey` are the
   * same room, which is the only way cross-track acoustic coupling stays
   * detectable without giving up the document's self-containment.
   */
  venueKey: z.string().min(1).max(64).optional(),
});

export const setupNodeSchema = z.object({
  id,
  /** References `devices.id` — a physical unit in the shared 機材台帳. */
  deviceId: id,
  /** Overrides the device name for this setup ("登壇者ハンドマイク"). */
  label: z.string().min(1).max(120).optional(),
  /** Required for mics, speakers, cameras and displays; ignored otherwise. */
  spaceId: id.optional(),
  /** `isolated` suppresses space coupling: headsets, in-ears, stream-only monitors. */
  coupling: z.enum(["open", "isolated"]).optional(),
  /** Set on software nodes (OBS, Meet) to the computer node they run on. */
  hostNodeId: id.optional(),
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
