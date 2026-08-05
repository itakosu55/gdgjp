import type { BuiltGraph, GraphEdge, VertexId } from "./graph";
import type { Medium } from "./types";

export type PathOptions = {
  medium: Medium;
  /**
   * When false, a path may not hop through a room. Setting it false is how the
   * linter tells "the mix bus feeds the conferencing app back to itself" (an
   * electrical Mix-Minus violation, fixed in the routing matrix) apart from
   * "the speakers are bleeding into the mic" (fixed with a headset).
   */
  allowSpaces?: boolean;
};

function usable(edge: GraphEdge, opts: PathOptions): boolean {
  if (!edge.media.includes(opts.medium)) return false;
  if (opts.allowSpaces === false && edge.kind === "space") return false;
  return true;
}

function reconstruct(prev: Map<VertexId, GraphEdge>, end: VertexId): GraphEdge[] {
  const path: GraphEdge[] = [];
  let cursor: VertexId | undefined = end;
  while (cursor !== undefined) {
    const edge = prev.get(cursor);
    if (!edge) break;
    path.push(edge);
    cursor = edge.from;
  }
  return path.reverse();
}

/** Shortest edge path from any of `starts` to any vertex in `targets`. */
export function findPath(
  graph: BuiltGraph,
  starts: readonly VertexId[],
  targets: ReadonlySet<VertexId>,
  opts: PathOptions,
): GraphEdge[] | null {
  for (const start of starts) {
    if (targets.has(start)) return [];
  }

  const visited = new Set<VertexId>(starts);
  const prev = new Map<VertexId, GraphEdge>();
  let frontier = [...starts];

  while (frontier.length > 0) {
    const next: VertexId[] = [];
    for (const vertex of frontier) {
      for (const edge of graph.outgoing.get(vertex) ?? []) {
        if (!usable(edge, opts) || visited.has(edge.to)) continue;
        visited.add(edge.to);
        prev.set(edge.to, edge);
        if (targets.has(edge.to)) return reconstruct(prev, edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  return null;
}

/** Shortest cycle that starts and ends at `start`, or null if there is none. */
export function findCycle(
  graph: BuiltGraph,
  start: VertexId,
  opts: PathOptions,
): GraphEdge[] | null {
  const visited = new Set<VertexId>([start]);
  const prev = new Map<VertexId, GraphEdge>();
  let frontier = [start];

  while (frontier.length > 0) {
    const next: VertexId[] = [];
    for (const vertex of frontier) {
      for (const edge of graph.outgoing.get(vertex) ?? []) {
        if (!usable(edge, opts)) continue;
        if (edge.to === start) return [...reconstruct(prev, vertex), edge];
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        prev.set(edge.to, edge);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  return null;
}

export function reachableFrom(
  graph: BuiltGraph,
  starts: readonly VertexId[],
  opts: PathOptions,
): Set<VertexId> {
  const visited = new Set<VertexId>(starts);
  let frontier = [...starts];

  while (frontier.length > 0) {
    const next: VertexId[] = [];
    for (const vertex of frontier) {
      for (const edge of graph.outgoing.get(vertex) ?? []) {
        if (!usable(edge, opts) || visited.has(edge.to)) continue;
        visited.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  return visited;
}

/** Node ids touched by a path, in traversal order and without repeats. */
export function pathNodeIds(graph: BuiltGraph, path: readonly GraphEdge[]): string[] {
  const ids: string[] = [];
  const push = (vertexId: VertexId) => {
    const vertex = graph.vertices.get(vertexId);
    if (vertex?.type !== "port") return;
    if (ids[ids.length - 1] !== vertex.nodeId) ids.push(vertex.nodeId);
  };
  for (const edge of path) {
    push(edge.from);
    push(edge.to);
  }
  return ids;
}
