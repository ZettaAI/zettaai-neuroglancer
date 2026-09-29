/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { parseAnnotationPropertyId } from "#src/annotation/index.js";
import { toggleBoolPropertyToolJson } from "#src/layer/annotation/tool_state.js";
import type { UserLayer, UserLayerConstructor } from "#src/layer/index.js";
import { layerTypes } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import {
  ensureUniquePropertyIdentifier,
  sanitizeAnnotationPropertyIdentifier,
} from "#src/ui/annotation_schema_tab.js";
import { bindCommandPalette } from "#src/ui/command_palette.js";
import { EDIT_SESSION_BINDINGS_KEY } from "#src/ui/custom_keybinds.js";
import {
  bindDefaultCopyHandler,
  bindDefaultPasteHandler,
} from "#src/ui/default_clipboard_handling.js";
import { registerDefaultCommands } from "#src/ui/default_commands.js";
import { setDefaultInputEventBindings } from "#src/ui/default_input_event_bindings.js";
import { makeDefaultViewer } from "#src/ui/default_viewer.js";
import { bindTitle } from "#src/ui/title.js";
import type { Tool } from "#src/ui/tool.js";
import { restoreTool } from "#src/ui/tool.js";
import { UrlHashBinding } from "#src/ui/url_hash_binding.js";
import type { EventActionMap } from "#src/util/event_action_map.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

declare let NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string | undefined;

type CustomToolBinding = {
  layer: string;
  // A single tool id, or a map of datasource scheme -> tool id so the same key
  // activates the datasource-appropriate tool for the active layer (e.g.
  // `calcadaMergeSegments` on a calcada layer, `grapheneMergeSegments` on a
  // graphene layer).
  tool: string | { readonly [scheme: string]: string };
  provider?: string;
};

type CustomBindings = {
  [key: string]: CustomToolBinding | string | boolean;
};

declare const CUSTOM_BINDINGS: CustomBindings | undefined;
export const hasCustomBindings =
  typeof CUSTOM_BINDINGS !== "undefined" &&
  Object.keys(CUSTOM_BINDINGS).length > 0;

export function convertLegacyAnnotationTags(layer: any) {
  if (layer?.tab === "tags") {
    layer.tab = "schema";
  }
  if (Array.isArray(layer?.panels)) {
    for (const panel of layer.panels) {
      if (panel?.tab === "tags") {
        panel.tab = "schema";
      }
    }
  }
  if (!Array.isArray(layer?.annotationProperties)) return false;
  const properties = layer.annotationProperties;
  const usedIdentifiers = new Set<string>();
  for (const property of properties) {
    if (typeof property?.tag !== "string" && typeof property?.id === "string") {
      usedIdentifiers.add(property.id);
    }
  }
  const convertedIdentifiers = new Map<string, string>();
  let converted = false;
  layer.annotationProperties = properties.map((property: any) => {
    if (typeof property?.tag !== "string") return property;
    converted = true;
    const { tag, enum_labels, enum_values, ...booleanProperty } = property;
    let suggestedIdentifier =
      sanitizeAnnotationPropertyIdentifier(tag) || "tag";
    try {
      parseAnnotationPropertyId(suggestedIdentifier);
    } catch {
      suggestedIdentifier = sanitizeAnnotationPropertyIdentifier(
        `tag_${suggestedIdentifier}`,
      );
    }
    const identifier = ensureUniquePropertyIdentifier(
      suggestedIdentifier,
      usedIdentifiers,
    );
    usedIdentifiers.add(identifier);
    if (typeof property.id === "string") {
      convertedIdentifiers.set(property.id, identifier);
    }
    return { ...booleanProperty, id: identifier, type: "bool" };
  });
  if (typeof layer.shader === "string") {
    for (const [oldIdentifier, newIdentifier] of convertedIdentifiers) {
      const escapedIdentifier = oldIdentifier.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      layer.shader = layer.shader.replace(
        new RegExp(`\\bprop_${escapedIdentifier}(?=\\s*\\()`, "g"),
        `prop_${newIdentifier}`,
      );
    }
  }
  if (layer.toolBindings !== undefined) {
    for (const [key, tool] of Object.entries(layer.toolBindings)) {
      if (typeof tool !== "string" || !tool.startsWith("tagTool_")) continue;
      const identifier = convertedIdentifiers.get(
        tool.slice("tagTool_".length),
      );
      if (identifier !== undefined) {
        layer.toolBindings[key] = toggleBoolPropertyToolJson(identifier);
      }
    }
  }
  return converted;
}

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  const viewer = ((<any>window).viewer = makeDefaultViewer());
  setDefaultInputEventBindings(viewer.inputEventBindings);
  viewer.stateUpgrader = (state) => {
    // convert graphene state timestamp to layer timestamp
    const fixTimestamp = (layer: any) => {
      if (layer.source?.state?.timestamp) {
        layer.timestamp = layer.source.state.timestamp;
        layer.source.state.timestamp = undefined;
      }
    };
    if (state.layers) {
      const layers = Array.isArray(state.layers)
        ? state.layers
        : Object.values(state.layers);
      layers.map(fixTimestamp);
      let convertedLegacyAnnotationTags = false;
      for (const layer of layers) {
        convertedLegacyAnnotationTags =
          convertLegacyAnnotationTags(layer) || convertedLegacyAnnotationTags;
      }
      if (convertedLegacyAnnotationTags) {
        const status = new StatusMessage();
        status.setErrorMessage(
          "Warning: Local annotations in deprecated format have been safely converted.  Copy this state again to preserve in the new format.",
        );
      }
    }
    return state;
  };

  const bindNonLayerSpecificTool = (
    obj: unknown,
    toolKey: string,
    desiredLayerType: UserLayerConstructor,
    desiredProvider?: string,
  ) => {
    let previousTool: Tool<object> | undefined;
    let previousLayer: UserLayer | undefined;
    if (typeof obj === "string") {
      obj = { type: obj };
    }
    verifyObject(obj);
    const type = verifyObjectProperty(obj, "type", verifyString);
    viewer.bindAction(`tool-${type}`, () => {
      const acceptableLayers = viewer.layerManager.managedLayers.filter(
        (managedLayer) => {
          const correctLayerType =
            managedLayer.layer instanceof desiredLayerType;
          if (desiredProvider && correctLayerType) {
            for (const dataSource of managedLayer.layer?.dataSources || []) {
              const protocol = viewer.dataSourceProvider.getProvider(
                dataSource.spec.url,
              )[2];
              if (protocol === desiredProvider) {
                return true;
              }
            }
            return false;
          } else {
            return correctLayerType;
          }
        },
      );
      if (acceptableLayers.length > 0) {
        const firstLayer = acceptableLayers[0].layer;
        if (firstLayer) {
          if (firstLayer !== previousLayer) {
            previousTool = restoreTool(firstLayer, obj);
            previousLayer = firstLayer;
          }
          if (previousTool) {
            viewer.activateTool(toolKey, previousTool);
          }
        }
      }
    });
  };

  // Like `bindNonLayerSpecificTool`, but selects the tool to activate based on
  // the active layer's datasource scheme, so a single key maps to the
  // datasource-appropriate tool (e.g. `keym` -> calcadaMergeSegments on a
  // calcada layer, grapheneMergeSegments on a graphene layer). Bails silently
  // when no matching layer/scheme is present.
  const bindProviderSpecificTool = (
    toolByScheme: { readonly [scheme: string]: string },
    toolKey: string,
    actionName: string,
    desiredLayerType: UserLayerConstructor,
  ) => {
    let previousTool: Tool<object> | undefined;
    let previousLayer: UserLayer | undefined;
    let previousToolType: string | undefined;
    viewer.bindAction(actionName, () => {
      for (const managedLayer of viewer.layerManager.managedLayers) {
        const layer = managedLayer.layer;
        if (!(layer instanceof desiredLayerType)) continue;
        let toolType: string | undefined;
        for (const dataSource of layer.dataSources || []) {
          let scheme: string | undefined;
          try {
            scheme = viewer.dataSourceProvider.getProvider(
              dataSource.spec.url,
            )[2];
          } catch {
            continue;
          }
          if (scheme !== undefined && toolByScheme[scheme] !== undefined) {
            toolType = toolByScheme[scheme];
            break;
          }
        }
        if (toolType === undefined) continue;
        if (layer !== previousLayer || toolType !== previousToolType) {
          previousTool = restoreTool(layer, { type: toolType });
          previousLayer = layer;
          previousToolType = toolType;
        }
        if (previousTool) {
          viewer.activateTool(toolKey, previousTool);
        }
        return;
      }
    });
  };

  if (hasCustomBindings) {
    const deleteKey = (map: EventActionMap, key: string) => {
      map.delete(key);
      for (const pMap of map.parents) {
        deleteKey(pMap, key);
      }
    };

    for (const [key, val] of Object.entries(CUSTOM_BINDINGS!)) {
      // The `editSession` section is session-scoped keybind config consumed by
      // the edit-session hotkey binder (TM-315), not a global keyboard binding.
      if (key === EDIT_SESSION_BINDINGS_KEY) continue;
      deleteKey(viewer.inputEventBindings.global, key);
      deleteKey(viewer.inputEventBindings.perspectiveView, key);
      deleteKey(viewer.inputEventBindings.sliceView, key);
      if (typeof val === "string") {
        viewer.inputEventBindings.global.set(key, val);
      } else if (typeof val === "boolean") {
        // not doing anything because we just use this to delete keybinds
      } else {
        const layerConstructor = layerTypes.get(val.layer);
        const toolKey = key.charAt(key.length - 1).toUpperCase();
        if (typeof val.tool === "object" && val.tool !== null) {
          // Datasource-aware binding: one key, scheme -> tool id map. The key
          // maps to a synthetic action that resolves the tool at press time
          // from the active layer's datasource scheme.
          const actionName = `tool-custom-${key}`;
          viewer.inputEventBindings.global.set(key, actionName);
          if (layerConstructor) {
            bindProviderSpecificTool(
              val.tool,
              toolKey,
              actionName,
              layerConstructor,
            );
          }
        } else {
          viewer.inputEventBindings.global.set(key, `tool-${val.tool}`);
          if (layerConstructor) {
            bindNonLayerSpecificTool(
              val.tool,
              toolKey,
              layerConstructor,
              val.provider,
            );
          }
        }
      }
    }
  }

  const hashBinding = viewer.registerDisposer(
    new UrlHashBinding(
      viewer.state,
      viewer.dataSourceProvider.sharedKvStoreContext,
      {
        defaultFragment:
          typeof NEUROGLANCER_DEFAULT_STATE_FRAGMENT !== "undefined"
            ? NEUROGLANCER_DEFAULT_STATE_FRAGMENT
            : undefined,
        upgradeState: viewer.stateUpgrader,
      },
    ),
  );
  viewer.registerDisposer(
    hashBinding.parseError.changed.add(() => {
      const { value } = hashBinding.parseError;
      if (value !== undefined) {
        const status = new StatusMessage();
        status.setErrorMessage(`Error parsing state: ${value.message}`);
        console.log("Error parsing state", value);
      }
      hashBinding.parseError;
    }),
  );
  hashBinding.updateFromUrlHash();
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);
  registerDefaultCommands(viewer.commandRegistry);
  bindCommandPalette(viewer);

  return viewer;
}
