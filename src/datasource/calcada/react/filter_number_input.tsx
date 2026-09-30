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

import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

function format(value: number): string {
  return value === 0 ? "" : String(value);
}

/**
 * A numeric filter field that can be cleared. An empty field means zero, which
 * is what the server reads as "no filter"; the text is left as typed rather
 * than snapped to a parsed number, so clearing a field or typing "0." does not
 * fight back. Leaving the field shows the value actually in force, so a number
 * past the limit reads as the limit it was clamped to.
 */
export function FilterNumberInput({
  value,
  onValueChange,
  ...inputProps
}: {
  value: number;
  onValueChange: (value: number) => void;
} & Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type">) {
  const [text, setText] = useState(() => format(value));
  // Set while the value that comes back is the answer to this field's own
  // edit — including a clamped one, which must not overwrite a number still
  // being typed. Any other change (a restored link) replaces the text.
  const editing = useRef(false);
  useEffect(() => {
    if (editing.current) {
      editing.current = false;
      return;
    }
    setText(format(value));
  }, [value]);
  return (
    <Input
      {...inputProps}
      type="number"
      placeholder="0"
      value={text}
      onBlur={(event) => {
        // A clamp that left the value unchanged never echoes back.
        editing.current = false;
        setText(format(value));
        inputProps.onBlur?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = next.trim() === "" ? 0 : Number.parseFloat(next);
        if (!Number.isFinite(parsed) || parsed === value) return;
        editing.current = true;
        onValueChange(parsed);
      }}
    />
  );
}
