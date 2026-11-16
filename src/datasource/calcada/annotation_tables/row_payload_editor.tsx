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

import { isEqual } from "lodash-es";
import { useEffect, useRef, useState } from "react";

import type { RowPayloadEditing } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { PayloadField } from "#src/datasource/calcada/annotation_tables/payload_field.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { RefCounted } from "#src/util/disposable.js";

const LOADING_TEXT = "Loading…";
const SAVE_KEY = "Enter";

type Payload = Record<string, unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The row's payload, one field per schema property, saved once a field is left. */
export function RowPayloadEditor({ editing }: { editing: RowPayloadEditing }) {
  const [saved, setSaved] = useState<Payload>();
  const [error, setError] = useState<string>();
  // Bumped to put the fields back to the saved payload after a refusal.
  const [revision, setRevision] = useState(0);
  const draft = useRef<Payload>({});

  useEffect(() => {
    let current = true;
    editing.read().then(
      (payload) => {
        if (!current) return;
        draft.current = { ...payload };
        setSaved(payload);
      },
      (readError: unknown) => current && setError(errorText(readError)),
    );
    return () => {
      current = false;
    };
  }, [editing]);

  if (saved === undefined) {
    return error === undefined ? (
      <div className="calcada-annotations-empty">{LOADING_TEXT}</div>
    ) : (
      <div className="calcada-annotations-error">{error}</div>
    );
  }

  const save = () => {
    const payload = { ...draft.current };
    if (isEqual(payload, saved)) return;
    editing.save(payload).then(
      () => {
        setSaved(payload);
        setError(undefined);
      },
      (saveError: unknown) => {
        draft.current = { ...saved };
        setError(errorText(saveError));
        setRevision((count) => count + 1);
      },
    );
  };

  return (
    <div
      className="calcada-annotations-payload"
      onBlur={save}
      onKeyDown={(event) => event.key === SAVE_KEY && save()}
    >
      {Object.entries(editing.properties).map(([name, type]) => (
        <PayloadField
          key={`${name}:${revision}`}
          name={name}
          type={type}
          required={editing.requiredProperties.includes(name)}
          initialValue={saved[name]}
          disabled={editing.readonly}
          onValue={(value) => {
            if (value === undefined) delete draft.current[name];
            else draft.current[name] = value;
          }}
        />
      ))}
      {error !== undefined && (
        <div className="calcada-annotations-error">{error}</div>
      )}
    </div>
  );
}

export function mountRowPayloadEditor(
  parent: HTMLElement,
  context: RefCounted,
  editing: RowPayloadEditing,
) {
  const target = document.createElement("div");
  parent.appendChild(target);
  context.registerDisposer(
    mountComponent(target, RowPayloadEditor, { editing }),
  );
}
