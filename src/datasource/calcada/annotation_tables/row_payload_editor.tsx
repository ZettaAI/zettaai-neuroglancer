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
import { useEffect, useState } from "react";

import type { RowPayloadEditing } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { PayloadField } from "#src/datasource/calcada/annotation_tables/payload_field.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import type { RefCounted } from "#src/util/disposable.js";
import { Button } from "@/components/ui/button";

const LOADING_TEXT = "Loading…";
const SAVE_KEY = "Enter";
const SAVE_LABEL = "Save";

type Payload = Record<string, unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The row's payload, one field per schema property, saved with the Save button or Enter. */
export function RowPayloadEditor({ editing }: { editing: RowPayloadEditing }) {
  const [saved, setSaved] = useState<Payload | undefined>(editing.known);
  const [draft, setDraft] = useState<Payload>({ ...editing.known });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Bumped to put the fields back to the saved payload after a refusal.
  const [revision, setRevision] = useState(0);
  useSignalRerender(editing.readonlyChanged);

  useEffect(() => {
    let current = true;
    editing.read().then(
      (payload) => {
        if (!current) return;
        setDraft({ ...payload });
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

  const changed = !isEqual(draft, saved);
  const save = () => {
    if (!changed || saving) return;
    const payload = draft;
    setSaving(true);
    editing
      .save(payload)
      .then(
        () => {
          setSaved(payload);
          setError(undefined);
        },
        (saveError: unknown) => {
          setDraft({ ...saved });
          setError(errorText(saveError));
          setRevision((count) => count + 1);
        },
      )
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="calcada-annotations-payload"
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
          onValue={(value) =>
            setDraft((current) => {
              const { [name]: _previous, ...rest } = current;
              return value === undefined ? rest : { ...rest, [name]: value };
            })
          }
        />
      ))}
      {!editing.readonly && (
        <Button
          size="xs"
          variant="outline"
          disabled={!changed || saving}
          onClick={save}
        >
          {SAVE_LABEL}
        </Button>
      )}
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
