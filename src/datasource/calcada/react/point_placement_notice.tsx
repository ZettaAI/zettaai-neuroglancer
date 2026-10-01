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

/** What to click while a point is being placed, over the views. */
export function PointPlacementNotice({ message }: { message: string }) {
  return (
    <div className="calcada-point-placement-banner" role="status">
      <span className="calcada-point-placement-target" aria-hidden="true" />
      <span>{message}</span>
      <span className="calcada-point-placement-hint">
        <kbd>Esc</kbd> to cancel
      </span>
    </div>
  );
}
