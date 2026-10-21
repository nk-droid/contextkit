"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { NetworkLink } from "../facts/network";
import {
  drawOrb,
  orbLayout,
  pickOrbNode,
  type OrbScene,
  type OrbView,
  type SpherePoint,
} from "../facts/orb";
import type { TooltipControls } from "./NetworkTooltip";

type SceneProps = Pick<OrbScene, "nodes" | "links" | "degree" | "selectedId" | "query">;

export function NetworkOrb({
  nodes,
  links,
  degree,
  selectedId,
  query,
  onToggleNode,
  onClearSelection,
  tooltip,
}: SceneProps & {
  links: NetworkLink[];
  onToggleNode: (id: string) => void;
  onClearSelection: () => void;
  tooltip: TooltipControls;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneProps | null>(null);
  const layoutRef = useRef<Map<string, SpherePoint>>(new Map());
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const viewRef = useRef<OrbView>({
    rotation: { x: -0.25, y: 0.6 },
    zoom: 1,
    width: 0,
    height: 0,
  });

  // The animation loop reads the latest props from here.
  useLayoutEffect(() => {
    sceneRef.current = { nodes, links, degree, selectedId, query };
  });

  useEffect(() => {
    layoutRef.current = orbLayout(nodes, links);
  }, [links, nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const host = canvas?.parentElement;
    if (!canvas || !context || !host) return;
    const view = viewRef.current;

    // The canvas fills its host; a host not yet laid out measures zero and is ignored.
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height || (width === view.width && height === view.height)) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      view.width = width;
      view.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const scene = sceneRef.current;
      if (!dragRef.current) view.rotation.y += 0.0014;
      const ratio = window.devicePixelRatio || 1;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (scene) drawOrb(context, { ...scene, hoveredId: hoverRef.current }, layoutRef.current, view);
    };
    frame = requestAnimationFrame(render);

    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      view.zoom = Math.max(0.5, Math.min(2.6, view.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
    };
    canvas.addEventListener("wheel", zoom, { passive: false });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("wheel", zoom);
    };
  }, []);

  const nodeAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return pickOrbNode(
      nodes,
      layoutRef.current,
      viewRef.current,
      event.clientX - box.left,
      event.clientY - box.top,
    );
  };

  return (
    <div className="nw-orb-wrap">
      <canvas
        aria-label="Component relationship network, drawn as a rotating sphere"
        className="nw-orb"
        onPointerDown={(event) => {
          const { clientX: x, clientY: y } = event;
          dragRef.current = { startX: x, startY: y, x, y, moved: false };
          event.currentTarget.dataset.dragging = "true";
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
          tooltip.hide();
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag) {
            const rotation = viewRef.current.rotation;
            rotation.y += (event.clientX - drag.x) * 0.006;
            rotation.x = Math.max(
              -1.3,
              Math.min(1.3, rotation.x + (event.clientY - drag.y) * 0.006),
            );
            drag.x = event.clientX;
            drag.y = event.clientY;
            // A few pixels of jitter during a click is not a drag.
            if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4) drag.moved = true;
            return;
          }
          const hit = nodeAt(event);
          hoverRef.current = hit?.id ?? null;
          if (!hit) {
            tooltip.hide();
            return;
          }
          tooltip.show(
            {
              title: hit.name,
              body: hit.summary,
              meta: `${degree.get(hit.id)?.size ?? 0} connections · ${hit.family}`,
            },
            event,
          );
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          delete event.currentTarget.dataset.dragging;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (!drag || drag.moved) return;
          const hit = nodeAt(event);
          if (hit) onToggleNode(hit.id);
          else onClearSelection();
        }}
        ref={canvasRef}
        role="img"
      />
    </div>
  );
}
