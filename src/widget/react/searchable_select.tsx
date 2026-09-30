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

import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { TruncatedLabel } from "#src/widget/react/truncated_label.js";
import { buttonVariants } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * The height and font size shared by every Graph tab control — buttons,
 * dropdown/calendar triggers, and plain text inputs (whose own vendored
 * defaults are a full size larger: `h-8`/`text-base` vs. the `size="sm"`
 * buttons and dropdowns already use) — so a text field sitting next to a
 * button or dropdown in the same row renders the same height instead of
 * standing taller.
 */
export const CONTROL_SIZE_CLASS = "h-7 text-[0.8rem]";

/**
 * The trigger box shared by every Graph tab dropdown (searchable or not) and
 * by the Time control's calendar-popover trigger, so all of a segmentation
 * layer's control rows render the same height, font size, border, and
 * background — the single source of truth `SearchableSelect` uses
 * internally, exported so a non-dropdown trigger (the Time popover) can
 * match it exactly instead of re-deriving the same class string by hand.
 */
export function dropdownTriggerClassName(extra?: string) {
  return cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    "min-w-0 justify-between font-normal",
    extra,
  );
}

/**
 * A single-select dropdown over a flat option list: a filterable `Combobox`
 * when `searchable`, a plain `Select` otherwise. Both branches render an
 * identical trigger box and the same truncated-with-tooltip labels, so the
 * Graph tab's Branch (searchable) and Label (not) pickers read as one
 * control family instead of two differently-sized ones.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  onOpen,
  ariaLabel,
  searchable = false,
  searchPlaceholder = "Search",
  emptyText = "No options found.",
  className,
}: {
  options: readonly ListboxOption[];
  value: string;
  onChange: (key: string) => void;
  onOpen?: () => void;
  ariaLabel: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const selected = options.find((option) => option.key === value) ?? null;

  if (searchable) {
    return (
      <Combobox
        items={options}
        value={selected}
        itemToStringLabel={(option: ListboxOption) => option.label}
        itemToStringValue={(option: ListboxOption) => option.key}
        onValueChange={(option: ListboxOption | null) => {
          if (option === null || option.disabled === true) return;
          onChange(option.key);
        }}
        onOpenChange={(open: boolean) => {
          if (open) onOpen?.();
        }}
      >
        <ComboboxTrigger
          aria-label={ariaLabel}
          className={dropdownTriggerClassName(
            cn("w-full overflow-hidden", className),
          )}
        >
          <TruncatedLabel text={selected?.label ?? ""} />
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput showTrigger={false} placeholder={searchPlaceholder} />
          <ComboboxEmpty>{emptyText}</ComboboxEmpty>
          <ComboboxList>
            {(option: ListboxOption) => (
              <ComboboxItem
                key={option.key}
                value={option}
                disabled={option.disabled === true}
              >
                <TruncatedLabel text={option.label} />
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    );
  }

  return (
    <Select
      items={options.map((option) => ({
        value: option.key,
        label: option.label,
      }))}
      value={value}
      onValueChange={(key: string) => {
        const option = options.find((candidate) => candidate.key === key);
        if (option === undefined || option.disabled === true) return;
        onChange(key);
      }}
      onOpenChange={(open: boolean) => {
        if (open) onOpen?.();
      }}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size="sm"
        className={dropdownTriggerClassName(cn("w-full", className))}
      >
        <TruncatedLabel text={selected?.label ?? ""} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.key}
            value={option.key}
            disabled={option.disabled === true}
          >
            <TruncatedLabel text={option.label} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
