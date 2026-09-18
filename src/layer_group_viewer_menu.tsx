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
 * Preact implementation of the layer-group viewer dropdown (the menu holding
 * "Remove layer group", the per-state navigation-link selectors, and the
 * annotation alignment link section). Replaces the previous imperative
 * EnumSelectWidget-based menu; the neuroglancer `ContextMenu` is kept as the
 * positioning/dismissal shell and this component renders its entire content.
 * Follows the edit-session UI conventions (Preact + `--nge-*` tokens).
 */

import { useCallback } from "preact/hooks";

import { AlignmentLinkMenuSection } from "#src/alignment_link/ui/alignment_link_menu.js";
import { useAlignmentLinkStatus } from "#src/alignment_link/ui/interop/use_alignment_link_status.js";
import {
  LAYER_GROUP_SESSION_LOCK_REASON,
  layerGroupHoldsOnlyCopyOfSessionLayer,
  onSessionLayersChanged,
} from "#src/editing/adapters/session_layer_structure_lock.js";
import { mountComponent } from "#src/editing/ui/interop/component_mount.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import type { LayerGroupViewer } from "#src/layer_group_viewer.js";
import type { ContextMenu } from "#src/ui/context_menu.js";
import { confirmLayerGroupRemoval } from "#src/ui/layer_deletion_confirmation.js";
import type { Disposer } from "#src/util/disposable.js";
import type { TrackableEnum } from "#src/util/trackable_enum.js";

// Side effect: ensures the --nge-* tokens exist even when no editing panel is
// mounted (same convention as the confirm dialog / session-entry modal).
import "#src/editing/ui/editing_theme.css";
import "#src/layer_group_viewer_menu.css";

/**
 * One navigation-link row: label left, link-mode select right. The options
 * are derived from the model's enum (position/orientation links offer
 * linked/relative/unlinked; render scales/dimensions omit relative).
 */
function NavigationLinkRow({
  label,
  model,
  disabledReason,
}: {
  label: string;
  model: TrackableEnum<number>;
  disabledReason?: string;
}) {
  const value = useWatchable(model);
  const options = Object.keys(model.enumType)
    .filter((key) => Number.isNaN(Number(key)))
    .map((key) => key.toLowerCase());
  return (
    <label class="neuroglancer-layer-group-menu-row">
      <span>{label}</span>
      <select
        value={model.enumType[value].toLowerCase()}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        aria-label={`${label} link mode`}
        onChange={(event) => {
          model.restoreState((event.target as HTMLSelectElement).value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Removing a layer group deletes the layers no other group shows, so the
 * button asks first, naming them (see `layer_deletion_confirmation.ts`), and
 * removes the group straight away when it deletes none. While one of them
 * belongs to the active edit session the button is disabled with the reason
 * (see `session_layer_structure_lock.ts`), and re-enabled when the session
 * ends or the layer is shown elsewhere.
 */
function RemoveLayerGroupButton({ viewer }: { viewer: LayerGroupViewer }) {
  const { layerSpecification } = viewer;
  const { layerManager, root } = layerSpecification;
  useSignal(layerManager.layersChanged);
  useSignal(layerSpecification.rootLayers.layersChanged);
  useEvent(
    useCallback(
      (handler: () => void) => onSessionLayersChanged(root, handler),
      [root],
    ),
  );
  const lockReason = layerGroupHoldsOnlyCopyOfSessionLayer(layerManager)
    ? LAYER_GROUP_SESSION_LOCK_REASON
    : undefined;
  return (
    <button
      type="button"
      class="neuroglancer-layer-group-menu-remove"
      disabled={lockReason !== undefined}
      title={lockReason}
      onClick={() => {
        if (layerGroupHoldsOnlyCopyOfSessionLayer(layerManager)) return;
        if (!confirmLayerGroupRemoval(layerManager)) return;
        // A session that locked one of those layers while the prompt was up
        // wins.
        if (layerGroupHoldsOnlyCopyOfSessionLayer(layerManager)) return;
        layerManager.clear();
      }}
    >
      Remove layer group
    </button>
  );
}

export function LayerGroupViewerMenu({ viewer }: { viewer: LayerGroupViewer }) {
  const { viewerNavigationState } = viewer;
  const alignmentLink = useAlignmentLinkStatus(
    viewer.viewerState.alignmentLink,
  );
  // While the alignment link is active it owns these links (forcing the
  // follower's to unlinked and driving the values), so manual changes would
  // be overridden — disable the selectors to make that explicit.
  const ownedReason = alignmentLink?.status.enabled
    ? "Managed by the annotation alignment link"
    : undefined;

  // The Linked* wrappers expose TrackableEnum<NavigationLinkType> /
  // <NavigationSimpleLinkType>; the row renders either through the common
  // numeric-enum shape.
  const rows = [
    {
      label: "Render scale factors",
      model: viewerNavigationState.relativeDisplayScales.link,
    },
    {
      label: "Render dimensions",
      model: viewerNavigationState.displayDimensions.link,
    },
    {
      label: "Position",
      model: viewerNavigationState.position.link,
      disabledReason: ownedReason,
    },
    {
      label: "Cross-section orientation",
      model: viewerNavigationState.crossSectionOrientation.link,
      disabledReason: ownedReason,
    },
    {
      label: "Cross-section zoom",
      model: viewerNavigationState.crossSectionScale.link,
    },
    {
      label: "Cross-section depth range",
      model: viewerNavigationState.crossSectionDepthRange.link,
    },
    {
      label: "3-D projection orientation",
      model: viewerNavigationState.projectionOrientation.link,
    },
    {
      label: "3-D projection zoom",
      model: viewerNavigationState.projectionScale.link,
    },
    {
      label: "3-D projection depth range",
      model: viewerNavigationState.projectionDepthRange.link,
    },
  ] as Array<{
    label: string;
    model: TrackableEnum<number>;
    disabledReason?: string;
  }>;

  return (
    <div class="neuroglancer-layer-group-menu">
      <RemoveLayerGroupButton viewer={viewer} />
      {rows.map(({ label, model, disabledReason }) => (
        <NavigationLinkRow
          key={label}
          label={label}
          model={model}
          disabledReason={disabledReason}
        />
      ))}
      {alignmentLink !== undefined && (
        <AlignmentLinkMenuSection link={alignmentLink} />
      )}
    </div>
  );
}

/**
 * Mounts the menu content into a `ContextMenu`; the returned disposer is
 * registered on the context menu by the caller.
 */
export function mountLayerGroupViewerMenu(
  contextMenu: ContextMenu,
  viewer: LayerGroupViewer,
): Disposer {
  return mountComponent(contextMenu.element, LayerGroupViewerMenu, { viewer });
}
