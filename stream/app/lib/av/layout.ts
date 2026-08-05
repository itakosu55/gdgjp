import type { BuiltGraph, EdgeKind, VertexId } from "./graph";
import { nodeLabel } from "./graph";
import type { DeviceCategory, Medium } from "./types";

/**
 * Ranks the graph into columns for the signal-flow diagram.
 *
 * The setup document deliberately stores no coordinates, so the picture is
 * derived on every render. That is what lets a document written by hand — or
 * later, generated — become a diagram with no extra work.
 */

export type LayoutNode = {
  key: string;
  label: string;
  /** `null` for the room itself. */
  category: DeviceCategory | null;
  spaceKind: "acoustic" | "visual" | null;
  column: number;
  row: number;
};

export type LayoutEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  media: Medium[];
};

export type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  columns: number;
  rows: number;
};

const SPACE_PREFIX = "space:";

function vertexKey(graph: BuiltGraph, vertexId: VertexId): string | null {
  const vertex = graph.vertices.get(vertexId);
  if (!vertex) return null;
  return vertex.type === "port" ? vertex.nodeId : `${SPACE_PREFIX}${vertex.spaceId}`;
}

export function layoutGraph(graph: BuiltGraph): Layout {
  const keys: string[] = [];
  const meta = new Map<string, Omit<LayoutNode, "column" | "row">>();

  for (const resolved of graph.nodes.values()) {
    keys.push(resolved.id);
    meta.set(resolved.id, {
      key: resolved.id,
      label: nodeLabel(resolved),
      category: resolved.model.category,
      spaceKind: null,
    });
  }
  for (const space of graph.spaces.values()) {
    const key = `${SPACE_PREFIX}${space.id}`;
    keys.push(key);
    meta.set(key, { key, label: space.label, category: null, spaceKind: space.kind });
  }

  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    const from = vertexKey(graph, edge.from);
    const to = vertexKey(graph, edge.to);
    if (!from || !to || from === to) continue;
    const dedupeKey = `${from}->${to}:${edge.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    edges.push({ from, to, kind: edge.kind, media: edge.media });
  }

  const column = rankNodes(keys, edges);
  const rowCursor = new Map<number, number>();
  const nodes: LayoutNode[] = keys
    .map((key) => {
      const base = meta.get(key);
      if (!base) return null;
      const col = column.get(key) ?? 0;
      const row = rowCursor.get(col) ?? 0;
      rowCursor.set(col, row + 1);
      return { ...base, column: col, row };
    })
    .filter((node): node is LayoutNode => node !== null);

  return {
    nodes,
    edges,
    columns: nodes.reduce((max, node) => Math.max(max, node.column + 1), 0),
    rows: [...rowCursor.values()].reduce((max, count) => Math.max(max, count), 0),
  };
}

/**
 * Longest-path ranking, on the graph with its loops cut.
 *
 * Cycles are the whole point of this tool, so ranking cannot assume a DAG — but
 * it cannot relax over one either. Every pass around a loop adds another column,
 * so a single howling path drags the diagram thousands of pixels wide. Cut the
 * back edges first (what dagre does), then rank what is left.
 */
function rankNodes(keys: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const edge of withoutBackEdges(keys, edges)) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  const rank = new Map<string, number>(keys.map((key) => [key, 0]));
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const key of keys) {
      const sources = incoming.get(key);
      if (!sources || sources.length === 0) continue;
      let best = rank.get(key) ?? 0;
      for (const source of sources) {
        const candidate = (rank.get(source) ?? 0) + 1;
        if (candidate > best) best = candidate;
      }
      if (best !== rank.get(key)) {
        rank.set(key, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/**
 * Iterative depth-first search that drops each edge pointing back at a node
 * still on the stack. Those are exactly the edges that close a loop.
 */
function withoutBackEdges(keys: readonly string[], edges: readonly LayoutEdge[]): LayoutEdge[] {
  const outgoing = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const dropped = new Set<LayoutEdge>();

  for (const start of keys) {
    if (state.has(start)) continue;
    state.set(start, ON_STACK);
    const stack: { key: string; next: number }[] = [{ key: start, next: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const out = outgoing.get(frame.key) ?? [];
      if (frame.next >= out.length) {
        state.set(frame.key, DONE);
        stack.pop();
        continue;
      }
      const edge = out[frame.next];
      frame.next += 1;
      if (!edge) continue;
      const target = state.get(edge.to);
      if (target === ON_STACK) {
        dropped.add(edge);
        continue;
      }
      if (target === DONE) continue;
      state.set(edge.to, ON_STACK);
      stack.push({ key: edge.to, next: 0 });
    }
  }

  return edges.filter((edge) => !dropped.has(edge));
}
