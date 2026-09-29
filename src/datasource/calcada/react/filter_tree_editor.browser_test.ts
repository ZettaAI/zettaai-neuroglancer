import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import type { FilterGroup } from "#src/datasource/calcada/candidate_filter_tree.js";
import { emptyFilterTree } from "#src/datasource/calcada/candidate_filter_tree.js";
import { FilterTreeEditor } from "#src/datasource/calcada/react/filter_tree_editor.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

const SIDE_PANEL_WIDTH_PX = 260;
let host: HTMLDivElement;
let disposer: Disposer;
let tree: FilterGroup;

function mount(initial: FilterGroup) {
  tree = initial;
  host = document.createElement("div");
  host.className = "calcada-trace-tab";
  host.style.cssText = `width: ${SIDE_PANEL_WIDTH_PX}px;`;
  document.body.appendChild(host);
  const render = () => {
    disposer = mountComponent(host, FilterTreeEditor, {
      tree,
      onChange: (next) => {
        tree = next;
        render();
      },
    });
  };
  render();
}

afterEach(() => {
  invokeDisposer(disposer);
  host.remove();
});

// mountComponent renders asynchronously; each click waits for its button.
async function click(label: string, index = 0) {
  const button = await vi.waitFor(() => {
    const found = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => b.textContent?.trim() === label)[index];
    expect(found).toBeDefined();
    return found;
  });
  button.click();
}

describe("FilterTreeEditor", () => {
  it("adds conditions and a nested group, and toggles a group's operator", async () => {
    mount(emptyFilterTree());
    await click("+ condition");
    await vi.waitFor(() => expect(tree.children).toHaveLength(1));
    await click("+ condition");
    await vi.waitFor(() => expect(tree.children).toHaveLength(2));
    await vi.waitFor(() =>
      expect(host.querySelectorAll(".calcada-filter-op")).toHaveLength(1),
    );
    await click("AND");
    await vi.waitFor(() => expect(tree.op).toBe("or"));
    await click("+ group");
    await vi.waitFor(() =>
      expect(tree.children[2]).toMatchObject({ kind: "group", op: "and" }),
    );
  });

  it("removes a nested group with its contents", async () => {
    mount({
      kind: "group",
      op: "and",
      children: [{ kind: "group", op: "or", children: [] }],
    });
    const remove = await vi.waitFor(() => {
      const found = host.querySelector<HTMLButtonElement>(
        ".calcada-filter-group .calcada-filter-remove",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    remove.click();
    await vi.waitFor(() => expect(tree.children).toEqual([]));
  });

  it("keeps a nested group's first row removable on its own", async () => {
    const leaf = {
      kind: "condition" as const,
      field: { measure: "score" as const },
      cmp: ">=" as const,
      value: 0.5,
    };
    mount({
      kind: "group",
      op: "and",
      children: [{ kind: "group", op: "or", children: [leaf, leaf] }],
    });
    const rowRemove = await vi.waitFor(() => {
      const found = host.querySelector<HTMLButtonElement>(
        ".calcada-filter-group .calcada-filter-condition .calcada-filter-remove",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    const rect = rowRemove.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    expect(hit).toBe(rowRemove);
  });

  it("fits the side panel with a three-level tree", async () => {
    const leaf = {
      kind: "condition" as const,
      field: {
        side: "candidate" as const,
        measure: "share" as const,
        class: "vasculature" as const,
      },
      cmp: ">=" as const,
      value: 0.8,
    };
    mount({
      kind: "group",
      op: "and",
      children: [
        {
          kind: "group",
          op: "or",
          children: [
            { kind: "group", op: "and", children: [leaf, leaf] },
            leaf,
          ],
        },
      ],
    });
    await vi.waitFor(() =>
      expect(host.querySelectorAll(".calcada-filter-condition").length).toBe(3),
    );
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  });
});
