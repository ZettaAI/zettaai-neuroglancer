/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// getComputedStyle rounds, so a label that fits exactly can report a
// scrollWidth a fraction wider than its clientWidth.
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * A single-line label that ellipsizes instead of wrapping, and reveals its
 * full text on hover or keyboard focus — but only when the text is actually
 * cut off, so a name that fits its row does not pop a tooltip repeating it.
 *
 * Names in these panels (branch names, timestamp labels) routinely outrun the
 * side panel's width, and wrapping them made dropdown rows different heights.
 */
export function TruncatedLabel({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);
  // A scroll-triggered close skips the normal fade/zoom-out: the trigger's
  // on-screen position is already stale, so animating the bubble out over
  // its old (now wrong) position would just be a few more frames of a
  // tooltip visibly detached from what it's supposed to be labeling.
  const [skipCloseAnimation, setSkipCloseAnimation] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setSkipCloseAnimation(false);
    setOpen(nextOpen);
  };

  // Scrolling any ancestor should hide the bubble immediately rather than
  // leaving it hovering over a trigger that has since moved or scrolled out
  // of view. Scroll doesn't bubble, but this still catches a scroll on any
  // nested scroll container because the capture phase visits every ancestor
  // on the way down.
  useEffect(() => {
    if (!open) return;
    const closeOnScroll = () => {
      setSkipCloseAnimation(true);
      setOpen(false);
    };
    document.addEventListener("scroll", closeOnScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", closeOnScroll, {
        capture: true,
      });
  }, [open]);

  const measure = () => {
    const label = labelRef.current;
    if (label === null) return;
    setTruncated(label.scrollWidth - label.clientWidth > OVERFLOW_TOLERANCE_PX);
  };

  // Layout effect, not a passive one: the measurement decides whether the
  // tooltip exists at all, so it has to land before the label is painted and
  // can be hovered.
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (label === null) return;
    // The row can be resized by the panel, and an option in a closed dropdown
    // has no width to measure until it is shown. This observer's lifecycle
    // doesn't depend on the text — only re-measuring below does — so it is
    // created once instead of on every text change.
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(measure, [text]);

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          <span
            ref={labelRef}
            className={cn("min-w-0 flex-1 truncate text-left", className)}
          />
        }
      >
        {text}
      </TooltipTrigger>
      {truncated && !skipCloseAnimation && (
        <TooltipContent>{text}</TooltipContent>
      )}
    </Tooltip>
  );
}
