import {
  nodeMatches,
  truncate,
  type LayerId,
  type NetworkLink,
  type NetworkNode,
  type NodeFamily,
} from "./network";

/*
 * The 3D orb. A glowing sphere is not achievable in SVG: the look comes from
 * additive blending, where overlapping node halos accumulate into light. A 2D
 * canvas gives that without a 3D library.
 */

export type SpherePoint = { x: number; y: number; z: number };
export type Rgb = [number, number, number];

export type OrbView = {
  rotation: { x: number; y: number };
  zoom: number;
  width: number;
  height: number;
};

export type OrbScene = {
  nodes: NetworkNode[];
  links: NetworkLink[];
  degree: Map<string, Set<string>>;
  selectedId: string | null;
  hoveredId: string | null;
  query: string;
};

export const orbBackground = "#000";

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
export const cssColor = ([red, green, blue]: Rgb) => `rgb(${red},${green},${blue})`;

/*
 * Every node type and link type has its own colour, from the data-viz skill's
 * documented palette, so types read without selecting anything. Nodes and
 * links are told apart by their marks, so each set was chosen to be distinct
 * within itself: the node colours, and the four solid link colours, stay
 * apart for colour-blind readers too (validated all-pairs on black). Seven
 * link colours cannot all stay apart on colour alone, so the other three link
 * types also carry a line pattern.
 */
export const nodeColors: Record<NodeFamily, Rgb> = {
  component: rgb("#3987e5"),
  external: rgb("#eda100"),
  store: rgb("#008300"),
  class: rgb("#4a3aa7"),
  callable: rgb("#d55181"),
};

export const linkColors: Record<LayerId, Rgb> = {
  declared: rgb("#ffffff"),
  flow: rgb("#1baf7a"),
  risk: rgb("#e34948"),
  shared: rgb("#e87ba4"),
  contains: rgb("#c3c2b7"),
  cross: rgb("#c98500"),
  within: rgb("#9085e9"),
};

// Dash and gap lengths in pixels; layers not listed are solid.
export const linkDashes: Partial<Record<LayerId, number[]>> = {
  risk: [6, 4],
  shared: [2, 4],
  contains: [1, 3],
};

// Outside the selection or search, nodes keep a faint glow and links become
// thin dark strokes: enough to keep the sphere's shape, not enough to compete
// with the links being inspected.
const dimmedNodeBrightness = 0.16;
const dimmedLinkColor: Rgb = [95, 120, 117];

// Families sit at slightly different depths so the shell has structure:
// architecture at the core, code on the outside.
const shellRadius: Record<NodeFamily, number> = {
  component: 0.72,
  store: 0.84,
  external: 0.88,
  class: 0.95,
  callable: 1,
};

export function orbLayout(nodes: NetworkNode[], links: NetworkLink[]) {
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  // A Fibonacci sphere gives an even starting shell with no clumping at the poles.
  let points: SpherePoint[] = nodes.map((_, position) => {
    const t = (position + 0.5) / nodes.length;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * position;
    return {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.sin(phi) * Math.sin(theta),
      z: Math.cos(phi),
    };
  });
  const adjacency = nodes.map((): number[] => []);
  links.forEach((link) => {
    const a = index.get(link.source);
    const b = index.get(link.target);
    if (a === undefined || b === undefined) return;
    adjacency[a].push(b);
    adjacency[b].push(a);
  });

  // Relax on the sphere surface: connected nodes attract, everything repels,
  // then renormalise so the result stays a shell instead of collapsing.
  for (let pass = 0; pass < 120; pass += 1) {
    const fx = new Float64Array(nodes.length);
    const fy = new Float64Array(nodes.length);
    const fz = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const dz = points[i].z - points[j].z;
        const distanceSquared = dx * dx + dy * dy + dz * dz + 0.0001;
        if (distanceSquared > 1.6) continue;
        const force = 0.0016 / distanceSquared;
        fx[i] += dx * force;
        fy[i] += dy * force;
        fz[i] += dz * force;
        fx[j] -= dx * force;
        fy[j] -= dy * force;
        fz[j] -= dz * force;
      }
    }
    adjacency.forEach((neighbours, i) =>
      neighbours.forEach((j) => {
        fx[i] += (points[j].x - points[i].x) * 0.01;
        fy[i] += (points[j].y - points[i].y) * 0.01;
        fz[i] += (points[j].z - points[i].z) * 0.01;
      }),
    );
    points = points.map((point, i) => {
      const x = point.x + fx[i];
      const y = point.y + fy[i];
      const z = point.z + fz[i];
      const magnitude = Math.hypot(x, y, z) || 1;
      return { x: x / magnitude, y: y / magnitude, z: z / magnitude };
    });
  }

  return new Map(
    nodes.map((node, i) => {
      const radius = shellRadius[node.family];
      return [
        node.id,
        { x: points[i].x * radius, y: points[i].y * radius, z: points[i].z * radius },
      ];
    }),
  );
}

export function projectOrb(point: SpherePoint, view: OrbView) {
  const cosX = Math.cos(view.rotation.x);
  const sinX = Math.sin(view.rotation.x);
  const cosY = Math.cos(view.rotation.y);
  const sinY = Math.sin(view.rotation.y);
  const x = point.x * cosY + point.z * sinY;
  let z = -point.x * sinY + point.z * cosY;
  const y = point.y * cosX - z * sinX;
  z = point.y * sinX + z * cosX;
  const radius = Math.min(view.width, view.height) * 0.4 * view.zoom;
  const perspective = 1 / (1.9 - z * 0.55);
  return {
    x: view.width / 2 + x * radius * perspective * 1.9,
    y: view.height / 2 + y * radius * perspective * 1.9,
    z,
    perspective,
  };
}

/** The node drawn nearest a canvas point, within 18px. */
export function pickOrbNode(
  nodes: NetworkNode[],
  layout: Map<string, SpherePoint>,
  view: OrbView,
  x: number,
  y: number,
) {
  let best: NetworkNode | null = null;
  let bestDistance = 18;
  for (const node of nodes) {
    const point = layout.get(node.id);
    if (!point) continue;
    const projected = projectOrb(point, view);
    const distance = Math.hypot(projected.x - x, projected.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

export function drawOrb(
  context: CanvasRenderingContext2D,
  scene: OrbScene,
  layout: Map<string, SpherePoint>,
  view: OrbView,
) {
  const { width, height } = view;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = orbBackground;
  context.fillRect(0, 0, width, height);

  const live = scene.nodes.filter((node) => layout.has(node.id));
  const projected = new Map(
    live.map((node) => [node.id, projectOrb(layout.get(node.id)!, view)]),
  );
  const { selectedId } = scene;
  const neighbours = selectedId ? scene.degree.get(selectedId) : null;
  const focused = Boolean(selectedId || scene.query);
  const isLit = (node: NetworkNode) =>
    (!scene.query || nodeMatches(node, scene.query)) &&
    (!selectedId || node.id === selectedId || neighbours?.has(node.id) === true);
  const lit = new Set(live.filter(isLit).map((node) => node.id));
  // With a selection, only the selected node's own links stay lit.
  const isLitLink = (link: NetworkLink) =>
    lit.has(link.source) &&
    lit.has(link.target) &&
    (!selectedId || link.source === selectedId || link.target === selectedId);
  const degreeOf = (id: string) => scene.degree.get(id)?.size ?? 0;

  const strokeLink = (link: NetworkLink, color: Rgb, strength: number, width: number) => {
    const a = projected.get(link.source);
    const b = projected.get(link.target);
    if (!a || !b) return;
    const depthFade = 0.45 + (0.55 * ((a.z + b.z) / 2 + 1)) / 2;
    context.setLineDash(linkDashes[link.layer] ?? []);
    context.strokeStyle = `rgba(${color.join(",")},${strength * depthFade})`;
    context.lineWidth = width * (0.6 + 0.4 * a.perspective * 2);
    context.beginPath();
    context.moveTo(a.x, a.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    context.quadraticCurveTo(
      midX + (midY - a.y) * 0.08,
      midY - (midX - a.x) * 0.08,
      b.x,
      b.y,
    );
    context.stroke();
  };

  // Links first, painted over rather than added up, so a line keeps its own
  // colour where it crosses others. Lit links in a focused view wait until
  // after the nodes.
  const litLinks: NetworkLink[] = [];
  scene.links.forEach((link) => {
    const contains = link.layer === "contains";
    if (!focused) {
      strokeLink(link, linkColors[link.layer], contains ? 0.4 : 0.55, contains ? 0.8 : 1.1);
    } else if (isLitLink(link)) {
      litLinks.push(link);
    } else {
      strokeLink(link, dimmedLinkColor, contains ? 0.05 : 0.12, contains ? 0.5 : 0.8);
    }
  });

  // Node halos add up into light, which is what makes the orb glow.
  context.globalCompositeOperation = "lighter";
  // Nodes back to front, so the nearest burn brightest.
  [...live]
    .sort((a, b) => projected.get(a.id)!.z - projected.get(b.id)!.z)
    .forEach((node) => {
      const point = projected.get(node.id)!;
      const base = node.family === "component" ? 3.2 : node.family === "class" ? 2.1 : 1.7;
      const radius =
        (base + Math.min(degreeOf(node.id) * 0.34, 7)) *
        (0.55 + point.perspective * 1.15) *
        view.zoom;
      const [red, green, blue] = nodeColors[node.family];
      const brightness = lit.has(node.id) ? 1 : dimmedNodeBrightness;
      const visibility = brightness * (0.5 + (0.5 * (point.z + 1)) / 2);
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 4.5);
      glow.addColorStop(0, `rgba(255,255,255,${0.85 * visibility})`);
      glow.addColorStop(0.22, `rgba(${red},${green},${blue},${0.75 * visibility})`);
      glow.addColorStop(1, `rgba(${red},${green},${blue},0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, radius * 4.5, 0, Math.PI * 2);
      context.fill();
    });

  // The inspected links go on top, brighter and wider than anything behind them.
  context.globalCompositeOperation = "source-over";
  litLinks.forEach((link) =>
    strokeLink(link, linkColors[link.layer], link.layer === "contains" ? 0.6 : 0.9, 1.7),
  );
  context.setLineDash([]);

  // Labels only where they can be read. In a focused view that is the lit
  // nodes; otherwise the components and hubs. The hovered node always has one.
  context.font = "600 11px 'Avenir Next', system-ui, sans-serif";
  context.textAlign = "center";
  live.forEach((node) => {
    const labelled =
      node.id === scene.hoveredId ||
      (focused
        ? lit.has(node.id)
        : node.family === "component" || degreeOf(node.id) >= 6);
    if (!labelled) return;
    const point = projected.get(node.id)!;
    // Labels on the far side are dimmed for depth, but never the selection's
    // own, and the lit neighbourhood's only a little.
    const alpha =
      point.z > -0.2 || node.id === selectedId ? 1 : focused ? 0.65 : 0.4;
    context.fillStyle = `rgba(233,245,244,${alpha})`;
    context.fillText(truncate(node.name, 22), point.x, point.y - 10);
  });
}
