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

import { useCallback, useEffect, useState } from "react";

import { TRACE_CURRENT_USER } from "#src/datasource/calcada/trace_state.js";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";

function labelOf(user: string) {
  return user === TRACE_CURRENT_USER ? "me" : user;
}

/**
 * Whose rejections hide a candidate. Nothing selected means anyone's.
 *
 * The choices are the people who have actually rejected something here — the
 * only ones the filter can tell apart — plus "me", which the server resolves
 * because the browser never learns its own user id. Refetched on open, since
 * someone may have started reviewing since the panel went up.
 */
export function RejectedByPicker({
  value,
  onChange,
  loadReviewers,
}: {
  value: readonly string[];
  onChange: (users: string[]) => void;
  loadReviewers: () => Promise<string[]>;
}) {
  const [reviewers, setReviewers] = useState<string[]>([]);
  const anchor = useComboboxAnchor();
  const load = useCallback(() => {
    loadReviewers()
      .then(setReviewers)
      .catch(() => undefined);
  }, [loadReviewers]);
  useEffect(() => {
    load();
  }, [load]);

  const items = [...new Set([TRACE_CURRENT_USER, ...reviewers, ...value])];

  return (
    <Combobox
      multiple
      items={items}
      value={[...value]}
      itemToStringLabel={labelOf}
      onValueChange={(next: string[]) => onChange(next)}
      onOpenChange={(open: boolean) => {
        if (open) load();
      }}
    >
      <ComboboxChips ref={anchor} className="calcada-trace-panel-reviewers">
        <ComboboxValue>
          {(selected: string[]) =>
            selected.map((user) => (
              <ComboboxChip key={user}>{labelOf(user)}</ComboboxChip>
            ))
          }
        </ComboboxValue>
        <ComboboxChipsInput placeholder={value.length === 0 ? "anyone" : ""} />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No one else has rejected a candidate here</ComboboxEmpty>
        <ComboboxList>
          {(user: string) => (
            <ComboboxItem key={user} value={user}>
              {labelOf(user)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
