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

import { useState } from "react";

import type {
  AnnotationPayloadValue,
  AnnotationPropertyType,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { Input } from "@/components/ui/input";

const REQUIRED_MARK = " *";
const REQUIRED_LABEL_SUFFIX = " (required)";
const TRUE_TEXT = "true";
const BOOLEAN_CHOICES = ["", TRUE_TEXT, "false"];
const UNSET_CHOICE_LABEL = "—";
const INTEGER_STEP = 1;
const ANY_STEP = "any";

function parsePayloadText(
  type: AnnotationPropertyType,
  text: string,
): AnnotationPayloadValue | undefined {
  if (text === "") return undefined;
  switch (type) {
    case "string":
      return text;
    case "boolean":
      return text === TRUE_TEXT;
    case "integer":
    case "number": {
      const parsed = Number(text);
      const valid =
        Number.isFinite(parsed) &&
        (type === "number" || Number.isInteger(parsed));
      return valid ? parsed : undefined;
    }
  }
}

/** How a stored payload value reads in its field; empty when it is not set. */
function payloadText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function PayloadField({
  name,
  type,
  required,
  initialValue,
  disabled = false,
  onValue,
}: {
  name: string;
  type: AnnotationPropertyType;
  required: boolean;
  initialValue?: unknown;
  disabled?: boolean;
  onValue: (value: AnnotationPayloadValue | undefined) => void;
}) {
  const [text, setText] = useState(() => payloadText(initialValue));
  const label = required ? `${name}${REQUIRED_LABEL_SUFFIX}` : name;
  const change = (next: string) => {
    setText(next);
    onValue(parsePayloadText(type, next));
  };
  const invalid = text !== "" && parsePayloadText(type, text) === undefined;
  return (
    <label className="calcada-annotations-payload-field">
      <span>
        {name}
        {required && REQUIRED_MARK}
      </span>
      {type === "boolean" ? (
        <select
          aria-label={label}
          className="calcada-annotations-payload-value"
          value={text}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
        >
          {BOOLEAN_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === "" ? UNSET_CHOICE_LABEL : choice}
            </option>
          ))}
        </select>
      ) : (
        <Input
          aria-label={label}
          aria-invalid={invalid}
          className="calcada-annotations-payload-value"
          type={type === "string" ? "text" : "number"}
          step={type === "integer" ? INTEGER_STEP : ANY_STEP}
          value={text}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </label>
  );
}
