/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Bridge between the edit-session host and the upstream layer UI that
 * can delete, rename, retype or re-subsource a layer: the layer bar, the layer
 * list panel, the layer side panel, the data-sources tab and the layer-group
 * menu.
 *
 * While any edit session is active, or being restored from the URL's
 * `editSession` intent, its layers (writable and reference) are locked against
 * those structural changes. The session finds its layers by name and paints
 * through their render layers, so each of them breaks it (or fails the
 * restore, which clears the intent), and after a delete or rename a reload
 * cannot restore it either. The controls stay in place, disabled with
 * {@link SESSION_LAYER_LOCK_REASON}, and come back when the session ends or
 * the restore fails.
 *
 * The lock is a guard against accidental clicks in NG's own UI, not a model
 * rule: `deleteLayer`, `changeLayerName`, `changeLayerType`, `LayerManager` and
 * state restore (JSON state editor, URL hash, the portal's Reset View) stay
 * unguarded.
 *
 * Like `segment_selection_lock.ts`, the host is duck-typed off
 * `TopLevelLayerListSpecification.editSessionHost`, so upstream UI takes no
 * `Viewer` or host dependency. With no host wired (test viewers, other
 * embeddings) nothing is locked.
 */

import type {
  LayerManager,
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";

/**
 * The reasons say when the lock lifts, not what to do about it: in the
 * portal's painting tasks, leaving the session is itself locked
 * (`EditSessionHost.lockExit`).
 */
export const SESSION_LAYER_LOCK_REASON =
  "Locked while this layer is part of the active edit session.";

export const LAYER_GROUP_SESSION_LOCK_REASON =
  "Locked while this group shows the only copy of a layer in the active edit session.";

interface SessionLayerLockHost {
  readonly sessionLock: {
    isSessionLayer(layerId: string): boolean;
    readonly activeSession: {
      readonly changed: { add(handler: () => void): () => void };
    };
    readonly restoringLayerIds: {
      readonly changed: { add(handler: () => void): () => void };
    };
  };
}

function lockHostOf(
  root: TopLevelLayerListSpecification,
): SessionLayerLockHost | undefined {
  const host = root.editSessionHost;
  if (host === undefined || host === null) return undefined;
  return host as SessionLayerLockHost;
}

/** Whether `layer` belongs to the active edit session, or one being restored. */
export function isSessionLayer(layer: ManagedUserLayer): boolean {
  const host = lockHostOf(layer.manager.root);
  return host?.sessionLock.isSessionLayer(layer.name) ?? false;
}

/**
 * Subscribe `handler` to sessions opening and closing, and to restores starting
 * and ending. Returns the disposer; a no-op when no host is wired.
 */
export function onSessionLayersChanged(
  root: TopLevelLayerListSpecification,
  handler: () => void,
): () => void {
  const host = lockHostOf(root);
  if (host === undefined) return () => {};
  const removeActiveWatch = host.sessionLock.activeSession.changed.add(handler);
  const removeRestoringWatch =
    host.sessionLock.restoringLayerIds.changed.add(handler);
  return () => {
    removeActiveWatch();
    removeRestoringWatch();
  };
}

/**
 * Call `apply(locked)` now, and again whenever `layer`'s lock flips: when a
 * session opens or closes, when a restore starts or ends, or when the layer is
 * renamed into or out of one. Returns the disposer.
 */
export function observeSessionLayerLock(
  layer: ManagedUserLayer,
  apply: (locked: boolean) => void,
): () => void {
  let locked = isSessionLayer(layer);
  apply(locked);
  const update = () => {
    const nowLocked = isSessionLayer(layer);
    if (nowLocked === locked) return;
    locked = nowLocked;
    apply(locked);
  };
  const removeSessionWatch = onSessionLayersChanged(layer.manager.root, update);
  const removeLayerWatch = layer.layerChanged.add(update);
  return () => {
    removeSessionWatch();
    removeLayerWatch();
  };
}

/**
 * Show an upstream icon button (`makeIcon`) as locked: `aria-disabled`, which
 * `icon.css` styles, and the lock reason as its title. `unlockedTitle` comes
 * back when the lock lifts. `aria-disabled` does not stop clicks, so the
 * icon's click handler must check {@link isSessionLayer} itself; a delete icon
 * gets both from {@link bindSessionLayerDeleteIcon}.
 */
export function showSessionLayerLockOnIcon(
  icon: HTMLElement,
  locked: boolean,
  unlockedTitle: string,
): void {
  if (locked) {
    icon.setAttribute("aria-disabled", "true");
    icon.title = SESSION_LAYER_LOCK_REASON;
  } else {
    icon.removeAttribute("aria-disabled");
    icon.title = unlockedTitle;
  }
}

/**
 * Wire an upstream delete icon for `layer`: shown locked while the layer
 * belongs to the edit session, and a click runs `onDelete` only while it does
 * not. Returns the disposer.
 */
export function bindSessionLayerDeleteIcon(
  icon: HTMLElement,
  layer: ManagedUserLayer,
  unlockedTitle: string,
  onDelete: () => void,
): () => void {
  const onClick = () => {
    if (!isSessionLayer(layer)) onDelete();
  };
  icon.addEventListener("click", onClick);
  const stopObserving = observeSessionLayerLock(layer, (locked) =>
    showSessionLayerLockOnIcon(icon, locked, unlockedTitle),
  );
  return () => {
    stopObserving();
    icon.removeEventListener("click", onClick);
  };
}

/**
 * Whether removing the layer group whose layers are `groupLayers` would delete
 * a session layer. A layer's `containers` are the root layer manager plus each
 * group that shows it, and the root drops a layer once no group shows it, so
 * a session layer that only this group shows is deleted with the group.
 */
export function layerGroupHoldsOnlyCopyOfSessionLayer(
  groupLayers: LayerManager,
): boolean {
  return groupLayers.managedLayers.some(
    (layer) =>
      isSessionLayer(layer) &&
      [...layer.containers].every(
        (container) =>
          container === groupLayers || container === layer.manager.rootLayers,
      ),
  );
}
