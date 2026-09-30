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

import { format } from "date-fns";
import { CalendarIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  CONTROL_SIZE_CLASS,
  dropdownTriggerClassName,
} from "#src/widget/react/searchable_select.js";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const TIMESTAMP_CONTROL_TITLE =
  "View segmentation at an earlier point in time (read-only). Clear to return to live.";

function timeOfDay(date: Date) {
  return format(date, "HH:mm:ss");
}

/**
 * Applies an `<input type="time">` value to a date without touching its
 * calendar day, so editing the time never silently walks the date across a
 * day boundary.
 */
function withTimeOfDay(date: Date, time: string) {
  const [hours, minutes, seconds] = time
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const next = new Date(date);
  next.setHours(hours, minutes, Number.isFinite(seconds) ? seconds : 0, 0);
  return next;
}

/**
 * The Calcada "Time" layer control: a calendar + time-of-day picker for the
 * time-travel timestamp, replacing the browser's `datetime-local` input.
 *
 * Writes go to the caller's intermediate timestamp rather than straight to
 * the layer, so the time-travel guard can confirm (or snap back) the switch.
 */
export function CalcadaTimestampPicker({
  intermediateTimestamp,
  timestampLimit,
}: {
  intermediateTimestamp: WatchableValueInterface<number | undefined>;
  timestampLimit: WatchableValueInterface<number>;
}) {
  const [open, setOpen] = useState(false);
  const timestamp = useWatchable(intermediateTimestamp);
  const earliest = new Date(useWatchable(timestampLimit));
  const selected = timestamp === undefined ? undefined : new Date(timestamp);

  // A partial/invalid time (e.g. only the hour typed so far) never commits —
  // the native input reports an empty `.value` for it, same as a genuinely
  // blank field — so this is the only way to know there's stray input sitting
  // in the field with nothing committed to `selected` for it to show up in.
  const [hasPartialInput, setHasPartialInput] = useState(false);
  const timeInputRef = useRef<HTMLInputElement>(null);

  // Any external change to the committed timestamp (calendar pick, another
  // control, the time-travel guard snapping back) makes a lingering partial
  // edit stale.
  useEffect(() => {
    setHasPartialInput(false);
  }, [timestamp]);

  const commit = (date: Date) => {
    const now = Date.now();
    intermediateTimestamp.value = Math.min(
      Math.max(date.valueOf(), earliest.valueOf()),
      now,
    );
  };

  const resetToLive = () => {
    intermediateTimestamp.value = undefined;
    setHasPartialInput(false);
    // `selected` was already undefined for a partial-but-invalid edit (it
    // never committed), so the controlled `value` prop below is unchanged
    // and React won't touch the DOM node — without this, the native input's
    // own uncommitted partial digits would keep showing after the reset.
    if (timeInputRef.current !== null) {
      timeInputRef.current.value = "";
    }
  };

  return (
    <div className="neuroglancer-calcada-timestamp-picker">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={dropdownTriggerClassName("min-w-28 flex-1 justify-start")}
        >
          <CalendarIcon />
          <span
            className={cn(
              "truncate",
              selected === undefined && "text-muted-foreground",
            )}
          >
            {selected === undefined
              ? "yyyy-MM-dd"
              : format(selected, "yyyy-MM-dd")}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected ?? new Date()}
            captionLayout="dropdown"
            startMonth={earliest}
            endMonth={new Date()}
            disabled={{ before: earliest, after: new Date() }}
            onSelect={(date: Date | undefined) => {
              if (date === undefined) return;
              commit(
                withTimeOfDay(
                  date,
                  selected === undefined
                    ? timeOfDay(new Date())
                    : timeOfDay(selected),
                ),
              );
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      <Input
        ref={timeInputRef}
        type="time"
        step="1"
        aria-label="Time of day"
        // Left to size itself. A time input renders in the browser's own
        // locale, so a 12-hour one lays out an AM/PM segment that no width
        // picked against `hh:mm:ss` would fit, and its intrinsic width tracks
        // whichever form it renders. That is narrower than the `w-28` this
        // used to carry — which was a chosen number, not the browser's — so
        // the dead strip beside the last segment goes without betting on a
        // locale. The few pixels left inside are the control's own padding
        // around its segments; reclaiming those needs a fixed width, which is
        // the bet this is avoiding.
        className={cn(
          CONTROL_SIZE_CLASS,
          "w-auto shrink-0 appearance-none [&::-webkit-calendar-picker-indicator]:hidden",
        )}
        value={selected === undefined ? "" : timeOfDay(selected)}
        // A native time/date input fires no `input`/`change` event at all
        // while it's mid-edit and incomplete (e.g. only the hour typed) —
        // only once the value becomes complete or is fully cleared. `keyup`
        // is the one event that still fires on every keystroke regardless,
        // so it's the only way to notice a partial edit as it happens rather
        // than only once (if ever) it resolves to something valid.
        onKeyUp={(e) => {
          setHasPartialInput(e.currentTarget.validity.badInput);
        }}
        onChange={(e) => {
          const time = e.currentTarget.value;
          if (time === "") return;
          setHasPartialInput(false);
          commit(withTimeOfDay(selected ?? new Date(), time));
        }}
      />

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Return to live"
              disabled={selected === undefined && !hasPartialInput}
              onClick={resetToLive}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipContent>Return to live</TooltipContent>
      </Tooltip>
    </div>
  );
}
