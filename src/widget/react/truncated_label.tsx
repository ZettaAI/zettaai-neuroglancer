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

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A single-line label that ellipsizes instead of wrapping, and reveals its
 * full text on hover or keyboard focus.
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("min-w-0 flex-1 truncate text-left", className)}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
