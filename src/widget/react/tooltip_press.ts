/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

const TOOLTIP_CONTENT = '[data-slot="tooltip-content"]';

/**
 * Whether a popup is closing because someone pressed inside a tooltip bubble.
 *
 * Tooltips portal to `<body>`, so a press inside one lands outside the
 * dropdown that opened it and Base UI reads it as an outside press. Selecting
 * the text of an option's tooltip would then dismiss the list on mouse-down,
 * unmounting the bubble mid-drag and leaving nothing selected. Popups pass
 * this to `eventDetails.cancel()` to stay open for that one case.
 */
export function isPressInsideTooltip(eventDetails: {
  readonly reason: string;
  readonly event: Event;
}) {
  if (eventDetails.reason !== "outside-press") return false;
  const { target } = eventDetails.event;
  return target instanceof Element && target.closest(TOOLTIP_CONTENT) !== null;
}
