"use client";

import { useEffect, useMemo, useRef } from "react";

export type TooltipContent = { title: string; body?: string; meta?: string };
type PointerPosition = { clientX: number; clientY: number };

export type TooltipControls = {
  show: (content: TooltipContent, pointer: PointerPosition) => void;
  move: (pointer: PointerPosition) => void;
  hide: () => void;
};

/*
 * The tooltip follows the pointer on every move, so it is updated directly in
 * the DOM rather than through state that would re-render the whole page.
 */
export function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const controls = useMemo<TooltipControls>(() => {
    const place = ({ clientX, clientY }: PointerPosition) => {
      const tip = ref.current;
      if (!tip?.dataset.visible) return;
      const padding = 14;
      const box = tip.getBoundingClientRect();
      let x = clientX + padding;
      let y = clientY + padding;
      if (x + box.width > window.innerWidth - 8) x = clientX - box.width - padding;
      if (y + box.height > window.innerHeight - 8) y = clientY - box.height - padding;
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${Math.max(8, y)}px`;
    };
    return {
      show(content, pointer) {
        const tip = ref.current;
        if (!tip) return;
        const title = document.createElement("b");
        title.textContent = content.title;
        const lines = [content.body, content.meta].flatMap((text, index) => {
          if (!text) return [];
          const line = document.createElement("span");
          line.textContent = text;
          if (index === 1) line.className = "nw-tip-meta";
          return [line];
        });
        tip.replaceChildren(title, ...lines);
        tip.dataset.visible = "true";
        place(pointer);
      },
      move: place,
      hide() {
        if (ref.current) delete ref.current.dataset.visible;
      },
    };
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", controls.hide, { passive: true });
    return () => window.removeEventListener("scroll", controls.hide);
  }, [controls]);

  return [ref, controls] as const;
}
