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

import { useLayoutEffect, useRef, useState } from "react";

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

  // Layout effect, not a passive one: the measurement decides whether the
  // tooltip exists at all, so it has to land before the label is painted and
  // can be hovered.
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (label === null) return;
    const measure = () =>
      setTruncated(
        label.scrollWidth - label.clientWidth > OVERFLOW_TOLERANCE_PX,
      );
    measure();
    // The row can be resized by the panel, and an option in a closed dropdown
    // has no width to measure until it is shown.
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [text]);

  return (
    <Tooltip>
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
      {truncated && <TooltipContent>{text}</TooltipContent>}
    </Tooltip>
  );
}
