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
 * Upstream layer UI must not let a click rename, retype or re-subsource a layer
 * of the active edit session: each breaks the session. The controls stay in
 * place, disabled with the reason, follow sessions opening and closing, and
 * re-check at action time in case the event races the lock.
 *
 * Covered here: the layer name input (layer side panel, layer list panel, tool
 * palette), the side panel's type select, the data-sources tab's subsource
 * checkboxes, the data-source URL input and add-source icon, and the
 * layer-group menu's "Remove layer group". The delete icons of the layer bar,
 * layer list panel and layer side panel live in classes that need a
 * `LayerGroupViewer` or `SidePanelManager`; each is wired through
 * `bindSessionLayerDeleteIcon`, which
 * `tests/editing/unit/adapters/session_layer_structure_lock.spec.ts` covers.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` (the workspace
 * globs `*.spec.ts` only).
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LAYER_GROUP_SESSION_LOCK_REASON,
  SESSION_LAYER_LOCK_REASON,
} from "#src/editing/adapters/session_layer_structure_lock.js";
import type {
  LayerManager,
  ManagedUserLayer,
  UserLayer,
} from "#src/layer/index.js";
import { changeLayerType } from "#src/layer/index.js";
import type {
  LayerDataSource,
  LoadedDataSubsource,
  LoadedLayerDataSource,
} from "#src/layer/layer_data_source.js";
import type { LayerGroupViewer } from "#src/layer_group_viewer.js";
import { LayerGroupViewerMenu } from "#src/layer_group_viewer_menu.js";
import { NavigationLinkType } from "#src/navigation_state.js";
import {
  DataSourceSubsourceView,
  DataSourceView,
  LayerDataSourcesTab,
  LoadedDataSourceView,
} from "#src/ui/layer_data_sources_tab.js";
import { LayerNameWidget, LayerTypeWidget } from "#src/ui/layer_side_panel.js";
import { MessageList } from "#src/util/message_list.js";
import { NullarySignal } from "#src/util/signal.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";

import { FakeLayerRoot } from "#tests/editing/fakes/fake_layer_root.js";

// The layer modules transitively read `WebGL2RenderingContext` constants at
// module-eval time (see `edit_session_host.spec.ts`).
vi.hoisted(() => {
  if (typeof (globalThis as any).WebGL2RenderingContext === "undefined") {
    (globalThis as any).WebGL2RenderingContext = {
      UNSIGNED_BYTE: 0x1401,
      BYTE: 0x1400,
      UNSIGNED_SHORT: 0x1403,
      SHORT: 0x1402,
      FLOAT: 0x1406,
      INT: 0x1404,
      UNSIGNED_INT: 0x1405,
    };
  }
});

// Only whether the type widget asks for a type change is under test; a real
// change needs a fully constructed user layer.
vi.mock("#src/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  changeLayerType: vi.fn(),
}));

let layers: FakeLayerRoot;
let layer: ManagedUserLayer;
const disposers: Array<() => void> = [];

beforeEach(() => {
  layers = new FakeLayerRoot();
  layer = layers.addLayer("segmentation");
  vi.mocked(changeLayerType).mockClear();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** Mount a widget element into the document and dispose it after the test. */
function mount<T extends { element: HTMLElement; dispose(): void }>(
  widget: T,
): T {
  document.body.appendChild(widget.element);
  disposers.push(() => {
    widget.dispose();
    widget.element.remove();
  });
  return widget;
}

/** Deliver a `change` the way a user edit that raced the lock would. */
function commitChange(element: HTMLElement) {
  element.dispatchEvent(new Event("change"));
}

describe("LayerNameWidget", () => {
  it("renames a layer that is not part of the session", () => {
    const { element } = mount(new LayerNameWidget(layer));
    layers.openSession("another-layer");

    expect(element.readOnly).toBe(false);
    expect(element.title).toBe("Rename layer");
    element.value = "renamed";
    commitChange(element);

    expect(layer.name).toBe("renamed");
  });

  it("is read-only with the reason while the layer is in the session", () => {
    const { element } = mount(new LayerNameWidget(layer));

    layers.openSession("segmentation");

    expect(element.readOnly).toBe(true);
    expect(element.title).toBe(SESSION_LAYER_LOCK_REASON);

    layers.closeSession();

    expect(element.readOnly).toBe(false);
    expect(element.title).toBe("Rename layer");
  });

  it("is read-only with the reason while the session is being restored", () => {
    const { element } = mount(new LayerNameWidget(layer));

    layers.startRestore("segmentation");

    expect(element.readOnly).toBe(true);
    expect(element.title).toBe(SESSION_LAYER_LOCK_REASON);
    element.value = "renamed";
    commitChange(element);
    expect(layer.name).toBe("segmentation");

    layers.endRestore();

    expect(element.readOnly).toBe(false);
    expect(element.title).toBe("Rename layer");
  });

  it("does not rename a session layer and restores the typed-over name", () => {
    layers.openSession("segmentation");
    const { element } = mount(new LayerNameWidget(layer));

    element.value = "renamed";
    commitChange(element);

    expect(layer.name).toBe("segmentation");
    expect(element.value).toBe("segmentation");
  });

  it("drops a name typed before the session locked the input", () => {
    const { element } = mount(new LayerNameWidget(layer));
    element.value = "renamed";

    layers.openSession("segmentation");
    element.dispatchEvent(new Event("blur"));

    expect(layer.name).toBe("segmentation");
    expect(element.value).toBe("segmentation");
  });
});

describe("LayerTypeWidget", () => {
  function typeWidget() {
    const userLayer = {
      type: "segmentation",
      managedLayer: layer,
      constructor: { typeAbbreviation: "seg" },
    } as unknown as UserLayer;
    return mount(new LayerTypeWidget(userLayer));
  }

  it("changes the type of a layer that is not part of the session", () => {
    const { element } = typeWidget();

    expect(element.disabled).toBe(false);
    expect(element.title).toBe("Change layer type");
    commitChange(element);

    expect(changeLayerType).toHaveBeenCalledTimes(1);
  });

  it("is disabled with the reason while the layer is in the session", () => {
    const { element } = typeWidget();

    layers.openSession("segmentation");

    expect(element.disabled).toBe(true);
    expect(element.title).toBe(SESSION_LAYER_LOCK_REASON);
    commitChange(element);
    expect(changeLayerType).not.toHaveBeenCalled();

    layers.closeSession();

    expect(element.disabled).toBe(false);
    expect(element.title).toBe("Change layer type");
  });
});

describe("data-sources tab subsource checkboxes", () => {
  function fakeSubsource(enabled: boolean) {
    return {
      enabled,
      activated: undefined,
      isActiveChanged: new NullarySignal(),
      messages: new MessageList(),
      subsourceEntry: { id: "default", default: true, subsource: {} },
    } as unknown as LoadedDataSubsource;
  }

  function fakeLoadedSource(subsources: LoadedDataSubsource[]) {
    return {
      enableDefaultSubsources: true,
      enabledSubsourcesChanged: new NullarySignal(),
      subsources,
      layer: { managedLayer: layer },
      transform: { mutableSourceRank: false, value: { sourceRank: 0 } },
    } as unknown as LoadedLayerDataSource;
  }

  function subsourceCheckbox(view: DataSourceSubsourceView) {
    return view.element.querySelector<HTMLInputElement>(
      ".neuroglancer-layer-data-sources-info-line > input",
    )!;
  }

  function defaultSubsourcesControls(view: LoadedDataSourceView) {
    const label = view.element.querySelector<HTMLLabelElement>(
      ".neuroglancer-layer-data-sources-source-default",
    )!;
    return { label, checkbox: label.querySelector("input")! };
  }

  describe("subsource enabled checkbox", () => {
    it("toggles a subsource of a layer that is not part of the session", () => {
      const subsource = fakeSubsource(true);
      const view = mount(
        new DataSourceSubsourceView(fakeLoadedSource([subsource]), subsource),
      );
      const checkbox = subsourceCheckbox(view);

      expect(checkbox.disabled).toBe(false);
      checkbox.click();

      expect(subsource.enabled).toBe(false);
    });

    it("is disabled with the reason while the layer is in the session", () => {
      const subsource = fakeSubsource(true);
      const view = mount(
        new DataSourceSubsourceView(fakeLoadedSource([subsource]), subsource),
      );
      const checkbox = subsourceCheckbox(view);
      const row = checkbox.parentElement!;

      layers.openSession("segmentation");

      expect(checkbox.disabled).toBe(true);
      expect(checkbox.title).toBe(SESSION_LAYER_LOCK_REASON);
      expect(row.title).toBe(SESSION_LAYER_LOCK_REASON);

      layers.closeSession();

      expect(checkbox.disabled).toBe(false);
      expect(checkbox.hasAttribute("title")).toBe(false);
      expect(row.hasAttribute("title")).toBe(false);
    });

    it("keeps a session layer's subsource enabled when a change races the lock", () => {
      layers.openSession("segmentation");
      const subsource = fakeSubsource(true);
      const loadedSource = fakeLoadedSource([subsource]);
      const view = mount(new DataSourceSubsourceView(loadedSource, subsource));
      const checkbox = subsourceCheckbox(view);

      checkbox.checked = false;
      commitChange(checkbox);

      expect(subsource.enabled).toBe(true);
      expect(loadedSource.enableDefaultSubsources).toBe(true);
      expect(checkbox.checked).toBe(true);
    });
  });

  describe("enable default subsource set checkbox", () => {
    const UNLOCKED_TITLE =
      "Enable the default set of subsources for this data source.";

    it("switches a layer that is not part of the session to its own subsource set", () => {
      const view = mount(new LoadedDataSourceView(fakeLoadedSource([])));
      const { checkbox, label } = defaultSubsourcesControls(view);

      expect(checkbox.disabled).toBe(false);
      expect(label.title).toBe(UNLOCKED_TITLE);
      checkbox.click();

      expect(view.source.enableDefaultSubsources).toBe(false);
    });

    it("is disabled with the reason while the layer is in the session", () => {
      const view = mount(new LoadedDataSourceView(fakeLoadedSource([])));
      const { checkbox, label } = defaultSubsourcesControls(view);

      layers.openSession("segmentation");

      expect(checkbox.disabled).toBe(true);
      expect(checkbox.title).toBe(SESSION_LAYER_LOCK_REASON);
      expect(label.title).toBe(SESSION_LAYER_LOCK_REASON);

      layers.closeSession();

      expect(checkbox.disabled).toBe(false);
      expect(checkbox.hasAttribute("title")).toBe(false);
      expect(label.title).toBe(UNLOCKED_TITLE);
    });

    it("keeps a session layer's subsource set when a change races the lock", () => {
      layers.openSession("segmentation");
      const view = mount(new LoadedDataSourceView(fakeLoadedSource([])));
      const { checkbox } = defaultSubsourcesControls(view);

      checkbox.checked = false;
      commitChange(checkbox);

      expect(view.source.enableDefaultSubsources).toBe(true);
      expect(checkbox.checked).toBe(true);
    });
  });
});

describe("data-sources tab URL input and add-source icon", () => {
  const URL = "precomputed://gs://bucket/segmentation";

  function fakeDataSource() {
    return {
      layer: { manager: {}, managedLayer: layer },
      spec: { url: URL },
      messages: new MessageList(),
      progressListener: { addListener() {}, removeListener() {} },
      changed: new NullarySignal(),
      loadState: undefined,
    } as unknown as LayerDataSource;
  }

  function urlInputView() {
    return mount(
      new DataSourceView({} as LayerDataSourcesTab, fakeDataSource()),
    );
  }

  /** The tab's add-source icon, shown after a source with a URL. */
  function addSourceIcon() {
    const userLayer = {
      managedLayer: layer,
      dataSources: [fakeDataSource()],
      dataSourcesChanged: new NullarySignal(),
    } as unknown as UserLayer;
    const tab = mount(new LayerDataSourcesTab(userLayer));
    return tab.element.querySelector<HTMLElement>(
      ".neuroglancer-layer-data-sources-container > .neuroglancer-icon",
    )!;
  }

  it("locks the URL input with the reason while the layer is in the session", () => {
    const { urlInput } = urlInputView();
    const { inputElement } = urlInput;
    expect(inputElement.contentEditable).toBe("true");

    layers.openSession("segmentation");

    expect(inputElement.contentEditable).toBe("false");
    expect(inputElement.title).toBe(SESSION_LAYER_LOCK_REASON);

    layers.closeSession();

    expect(inputElement.contentEditable).toBe("true");
    expect(inputElement.hasAttribute("title")).toBe(false);
  });

  it("locks the URL input while the session is being restored", () => {
    const view = urlInputView();
    const { inputElement } = view.urlInput;

    layers.startRestore("segmentation");

    expect(inputElement.contentEditable).toBe("false");
    expect(inputElement.title).toBe(SESSION_LAYER_LOCK_REASON);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    view.urlInput.onCommit.dispatch("precomputed://gs://bucket/other", true);
    expect(view.source.spec.url).toBe(URL);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    layers.endRestore();

    expect(inputElement.contentEditable).toBe("true");
  });

  it("locks the add-source icon with the reason while the layer is locked", () => {
    const icon = addSourceIcon();
    expect(icon.hasAttribute("aria-disabled")).toBe(false);
    expect(icon.title).toBe("Add additional data source");

    layers.openSession("segmentation");

    expect(icon.getAttribute("aria-disabled")).toBe("true");
    expect(icon.title).toBe(SESSION_LAYER_LOCK_REASON);

    layers.closeSession();
    layers.startRestore("segmentation");

    expect(icon.getAttribute("aria-disabled")).toBe("true");

    layers.endRestore();

    expect(icon.hasAttribute("aria-disabled")).toBe(false);
    expect(icon.title).toBe("Add additional data source");
  });
});

describe("layer-group menu Remove layer group", () => {
  interface FakeGroup {
    readonly managedLayers: ManagedUserLayer[];
    readonly layersChanged: NullarySignal;
    readonly clear: ReturnType<typeof vi.fn>;
  }

  function fakeGroup(): FakeGroup {
    return {
      managedLayers: [],
      layersChanged: new NullarySignal(),
      clear: vi.fn(),
    };
  }

  function showIn(shownLayer: ManagedUserLayer, ...groups: FakeGroup[]) {
    for (const group of groups) {
      group.managedLayers.push(shownLayer);
      shownLayer.containers.add(group as unknown as LayerManager);
    }
  }

  /** Mount the menu for `group`; returns its Remove button. */
  function mountMenu(group: FakeGroup): HTMLButtonElement {
    const link = new TrackableEnum(
      NavigationLinkType,
      NavigationLinkType.LINKED,
    );
    const viewer = {
      viewerNavigationState: new Proxy({}, { get: () => ({ link }) }),
      viewerState: { alignmentLink: undefined },
      layerSpecification: {
        layerManager: group,
        root: layers.root,
        rootLayers: layers.rootLayers,
      },
    } as unknown as LayerGroupViewer;
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => render(h(LayerGroupViewerMenu, { viewer }), container));
    disposers.push(() => {
      act(() => render(null, container));
      container.remove();
    });
    return container.querySelector<HTMLButtonElement>(
      ".neuroglancer-layer-group-menu-remove",
    )!;
  }

  it("removes a group whose session layers are also shown elsewhere", () => {
    const group = fakeGroup();
    showIn(layer, group, fakeGroup());
    act(() => layers.openSession("segmentation"));
    const button = mountMenu(group);

    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
    act(() => button.click());

    expect(group.clear).toHaveBeenCalledTimes(1);
  });

  it("is disabled with the reason while it shows the only copy of a session layer", () => {
    const group = fakeGroup();
    showIn(layer, group);
    const button = mountMenu(group);
    expect(button.disabled).toBe(false);

    act(() => layers.openSession("segmentation"));

    expect(button.disabled).toBe(true);
    expect(button.title).toBe(LAYER_GROUP_SESSION_LOCK_REASON);

    act(() => layers.closeSession());

    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
  });

  it("is disabled with the reason while the session is being restored", () => {
    const group = fakeGroup();
    showIn(layer, group);
    const button = mountMenu(group);

    act(() => layers.startRestore("segmentation"));

    expect(button.disabled).toBe(true);
    expect(button.title).toBe(LAYER_GROUP_SESSION_LOCK_REASON);

    act(() => layers.endRestore());

    expect(button.disabled).toBe(false);
  });

  it("does not remove the group when a click races the lock", async () => {
    const group = fakeGroup();
    showIn(layer, group);
    const button = mountMenu(group);

    // Outside `act` the re-render is still queued, so the button is enabled.
    layers.openSession("segmentation");
    expect(button.disabled).toBe(false);
    button.click();
    await act(async () => {});

    expect(group.clear).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
  });
});
