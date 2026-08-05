import type { Layout, LayoutNode } from "~/lib/av/layout";

/**
 * Read-only picture of the signal flow, laid out from the document on every
 * render. Editing happens in the tables; visual editing is the OBS extension's
 * job, not this app's.
 */

const COL_WIDTH = 210;
const ROW_HEIGHT = 74;
const BOX_WIDTH = 168;
const BOX_HEIGHT = 44;
const PADDING = 24;

function position(node: LayoutNode) {
  return {
    x: PADDING + node.column * COL_WIDTH,
    y: PADDING + node.row * ROW_HEIGHT,
  };
}

/** Solid = cable, dotted = inside a computer, dashed = through the room. */
const EDGE_DASH: Record<string, string | undefined> = {
  cable: undefined,
  internal: "2 3",
  host: "1 3",
  space: "6 4",
};

export function SignalFlowDiagram({ layout }: { layout: Layout }) {
  if (layout.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">機材を追加すると信号フロー図が表示されます。</p>
    );
  }

  const positions = new Map(layout.nodes.map((node) => [node.key, position(node)]));
  const width = PADDING * 2 + Math.max(1, layout.columns - 1) * COL_WIDTH + BOX_WIDTH;
  const height = PADDING * 2 + Math.max(1, layout.rows) * ROW_HEIGHT;

  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="信号フロー図"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="max-w-none text-foreground"
      >
        <title>信号フロー図</title>
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + BOX_WIDTH;
          const y1 = from.y + BOX_HEIGHT / 2;
          const x2 = to.x;
          const y2 = to.y + BOX_HEIGHT / 2;
          return (
            <line
              key={`${edge.from}-${edge.to}-${edge.kind}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeDasharray={EDGE_DASH[edge.kind]}
              markerEnd="url(#flow-arrow)"
              className="stroke-muted-foreground"
              strokeWidth={edge.kind === "space" ? 1.5 : 1}
            />
          );
        })}

        {layout.nodes.map((node) => {
          const { x, y } = position(node);
          const isSpace = node.spaceKind !== null;
          return (
            <g key={node.key}>
              <rect
                x={x}
                y={y}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={8}
                className={
                  isSpace ? "fill-muted stroke-muted-foreground/60" : "fill-card stroke-border"
                }
                strokeDasharray={isSpace ? "5 4" : undefined}
              />
              <text x={x + 10} y={y + 18} className="fill-foreground text-[11px] font-medium">
                {truncate(node.label, 22)}
              </text>
              <text x={x + 10} y={y + 33} className="fill-muted-foreground text-[10px]">
                {isSpace
                  ? node.spaceKind === "acoustic"
                    ? "音響空間"
                    : "視覚空間"
                  : (node.category ?? "")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
