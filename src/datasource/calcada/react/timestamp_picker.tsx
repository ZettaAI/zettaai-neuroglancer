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
import { useState } from "react";

import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export const TIMESTAMP_CONTROL_TITLE =
  "View segmentation at an earlier point in time (read-only). Clear to return to live.";

const LIVE_LABEL = "— live —";

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

  const commit = (date: Date) => {
    const now = Date.now();
    intermediateTimestamp.value = Math.min(
      Math.max(date.valueOf(), earliest.valueOf()),
      now,
    );
  };

  return (
    <div
      className="neuroglancer-calcada-timestamp-picker"
      title={TIMESTAMP_CONTROL_TITLE}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "min-w-0 flex-1 justify-start font-normal",
          )}
        >
          <CalendarIcon />
          <span className="truncate">
            {selected === undefined
              ? LIVE_LABEL
              : format(selected, "yyyy-MM-dd HH:mm:ss")}
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
        type="time"
        step="1"
        aria-label="Time of day"
        className="w-28 shrink-0 appearance-none [&::-webkit-calendar-picker-indicator]:hidden"
        value={selected === undefined ? "" : timeOfDay(selected)}
        onChange={(e) => {
          const time = e.currentTarget.value;
          if (time === "") return;
          commit(withTimeOfDay(selected ?? new Date(), time));
        }}
      />

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Return to live"
        title="Return to live"
        disabled={selected === undefined}
        onClick={() => {
          intermediateTimestamp.value = undefined;
        }}
      >
        <XIcon />
      </Button>
    </div>
  );
}
