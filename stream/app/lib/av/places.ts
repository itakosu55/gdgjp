import type { Space } from "./schema";
import { SPACE_KINDS } from "./types";
import type { SpaceKind } from "./types";

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

/**
 * The media a place can be made of, in the order a place lists them.
 *
 * Derived rather than written out, so "a meeting is not a place" stays the one
 * rule `placeKeyOf` states above: a room form that spelled its own list would
 * be free to drift from it, and offering 伝送 as something a room *has* is
 * exactly the nonsense the key rule exists to refuse.
 */
export type PlaceKind = Exclude<SpaceKind, "transport">;

export const PLACE_KINDS: readonly PlaceKind[] = SPACE_KINDS.filter(
  (kind): kind is PlaceKind => kind !== "transport",
);

/**
 * Where a space sits among the spaces of its own place: air first, then sight.
 *
 * Which half of a room somebody happened to create first is not something a
 * reader can know, so it must not be what decides which half is drawn on top,
 * nor whose label captions the room. `SPACE_KINDS` already states the order
 * this app talks about media in, so using it wherever a place's spaces are
 * listed makes the diagram, the tree and the frame caption agree — and makes
 * renaming a hall move its caption whichever half was renamed, because the
 * caption always comes from the same half.
 */
export function spaceRank(kind: SpaceKind): number {
  return SPACE_KINDS.indexOf(kind);
}

/** One place's spaces, canonically ordered. Two of a kind keep document order. */
export function inPlaceOrder<T extends { kind: SpaceKind }>(spaces: readonly T[]): T[] {
  return [...spaces].sort((a, b) => spaceRank(a.kind) - spaceRank(b.kind));
}
