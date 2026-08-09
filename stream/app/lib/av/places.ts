import type { Space } from "./schema";

/**
 * A *place* is a physical location; a *space* is one medium of it.
 *
 * A hall is one place with two spaces — the air in it and the sightline across
 * it — and `venueKey` was reserved for exactly that: "these two spaces are the
 * same room". The distinction stopped being only the diagram's business when
 * coupling moved onto ports (§11.4). A node says where it *is*, one place, and
 * each of its coupling ports picks the space of that place its own medium can
 * reach — which is why an all-in-one terminal can be a mic and a screen at once
 * without the document naming two locations for it.
 *
 * A meeting is not a place: it is a path between places, and the joins in it
 * are already inside their computers.
 */

const PLACE_PREFIX = "place:";

export function placeKeyOf(space: Space): string | null {
  if (space.kind === "transport") return null;
  return `${PLACE_PREFIX}${space.venueKey ?? space.id}`;
}
