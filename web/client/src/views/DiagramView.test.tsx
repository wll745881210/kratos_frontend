// Smoke test for the block-diagram view. React Flow needs a few browser
// APIs that jsdom lacks; mock them minimally.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Spec } from "../model/types";
import { DiagramView, type DiagramOps } from "./DiagramView";

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // @ts-expect-error jsdom lacks DOMMatrixReadOnly
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor() {}
  };
});

function makeOps(): DiagramOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onAddModule: (r, t) => {
      calls.push(`addModule:${r}:${t}`);
      return null;
    },
    onRemoveModule: (r) => calls.push(`removeModule:${r}`),
    onAddCoupling: (f, k, t) => calls.push(`addCoupling:${f}:${k}:${t}`),
    onRemoveCoupling: (f, k, t) =>
      calls.push(`removeCoupling:${f}:${k}:${t ?? ""}`),
    onInspectRole: (r) => calls.push(`inspect:${r}`),
  };
}

const SPEC: Spec = {
  version: 1,
  meta: {},
  sections: {
    mesh: { n_cell_global: [64, 64, 1] },
    cycle: { t_lim: 0.2 },
    "module.flow": { type: "hydro", order: 0 },
    "module.chem": { type: "chemistry", order: 1 },
    "coupling.chem": { parasite: "flow" },
  },
};

describe("DiagramView", () => {
  it("renders module + core nodes", () => {
    render(<DiagramView spec={SPEC} ops={makeOps()} />);
    expect(screen.getByText("flow")).toBeInTheDocument();
    expect(screen.getByText("chem")).toBeInTheDocument();
    expect(screen.getByText("[mesh]")).toBeInTheDocument();
    expect(screen.getByText("chemistry · order 1")).toBeInTheDocument();
  });

  it("add module via toolbar", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. |new module role/), {
      target: { value: "mg" },
    });
    fireEvent.click(screen.getByText("+ module"));
    expect(ops.calls).toEqual(["addModule:mg:hydro"]);
  });

  it("disallows duplicate roles", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. |new module role/), {
      target: { value: "flow" },
    });
    expect(screen.getByText("+ module")).toBeDisabled();
  });

  it("reserved role is disabled with an explanation (post insertion)", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    const input = screen.getByPlaceholderText(/^e\.g\. |new module role/);
    // select the post type, type the natural-but-reserved role 'post'
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "post" },
    });
    fireEvent.change(input, { target: { value: "post" } });
    const btn = screen.getByText("+ module");
    expect(btn).toBeDisabled();
    expect(screen.getByText(/reserved section name/)).toBeInTheDocument();
    expect(ops.calls).toEqual([]);
    // a valid role clears the error and re-enables the button
    fireEvent.change(input, { target: { value: "subgrid" } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(ops.calls).toEqual(["addModule:subgrid:post"]);
  });

  it("double-click a module node opens its inspector", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    fireEvent.doubleClick(screen.getByText("chem"));
    expect(ops.calls).toEqual(["inspect:chem"]);
  });

  it("node action buttons edit, delete and couple", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    // laidOut order: cores, then modules by (order, role) => flow, chem
    fireEvent.click(screen.getAllByText("edit")[1]);
    expect(ops.calls).toEqual(["inspect:chem"]);

    ops.calls.length = 0;
    fireEvent.click(screen.getAllByText("delete")[0]);
    expect(ops.calls).toEqual(["removeModule:flow"]);

    ops.calls.length = 0;
    fireEvent.click(screen.getAllByText("link")[1]); // chem -> pick flow
    // chemistry has the outbound slot (parasite); the dialog offers it
    fireEvent.click(screen.getByText("parasite"));
    expect(ops.calls).toEqual(["addCoupling:chem:parasite:flow"]);
  });
});
