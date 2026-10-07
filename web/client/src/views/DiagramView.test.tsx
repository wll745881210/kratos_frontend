// Smoke test for the block-diagram view. React Flow needs a few browser
// APIs that jsdom lacks; mock them minimally.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { specToGraph } from "../model/graph";
import type { Spec } from "../model/types";
import { DiagramView, flowEdges, type DiagramOps } from "./DiagramView";

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
    onAddCoupling: (f, k, t, e) =>
      calls.push(
        `addCoupling:${f}:${k}:${t}${e ? `@${e.src}>${e.tgt}` : ""}`,
      ),
    onRemoveCoupling: (f, k, t) =>
      calls.push(`removeCoupling:${f}:${k}:${t ?? ""}`),
    onChainModule: (c, h, a) => calls.push(`chainModule:${c}:${h}:${a}`),
    onOrderAfter: (r, a) => calls.push(`orderAfter:${r}:${a}`),
    onRemoveOrderEdge: (f, t) => calls.push(`removeOrderEdge:${f}:${t}`),
    onInspectRole: (r) => calls.push(`inspect:${r}`),
    onInspectCore: (s) => calls.push(`inspectCore:${s}`),
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

  it("global boxes always render; absent sections marked unset", () => {
    render(<DiagramView spec={SPEC} ops={makeOps()} />);
    // SPEC has mesh+cycle but no unit/device/boundary sections
    expect(screen.getByText("[unit]")).toBeInTheDocument();
    expect(screen.getByText("[device]")).toBeInTheDocument();
    expect(screen.getByText("[boundary]")).toBeInTheDocument();
    expect(screen.getAllByText("unset")).toHaveLength(3);
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

  it("double-click a global box opens the core inspector", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    fireEvent.doubleClick(screen.getByText("[mesh]"));
    expect(ops.calls).toEqual(["inspectCore:mesh"]);
  });

  it("double-click an unset global box still inspects it", () => {
    const ops = makeOps();
    render(<DiagramView spec={SPEC} ops={ops} />);
    // SPEC has no unit/device/boundary sections -> "unset" boxes
    fireEvent.doubleClick(screen.getByText("[unit]"));
    expect(ops.calls).toEqual(["inspectCore:unit"]);
  });

  it("node action buttons edit, delete and couple", () => {
    const ops = makeOps();
    // flow must be a chem_hydro module for chemistry's parasite
    // binding (q_che) to be legal.
    const spec: Spec = structuredClone(SPEC);
    spec.sections["module.flow"].type = "chem_hydro";
    render(<DiagramView spec={spec} ops={ops} />);
    // laidOut order: cores, then modules by (order, role) => flow, chem
    fireEvent.click(screen.getAllByText("edit")[1]);
    expect(ops.calls).toEqual(["inspect:chem"]);

    ops.calls.length = 0;
    fireEvent.click(screen.getAllByText("delete")[0]);
    expect(ops.calls).toEqual(["removeModule:flow"]);

    ops.calls.length = 0;
    fireEvent.click(screen.getAllByText("link")[1]); // chem -> pick flow
    // chemistry declares the parasite slot; the dialog offers declarer.slot
    fireEvent.click(screen.getByText("+ chem.parasite"));
    expect(ops.calls).toEqual(["addCoupling:chem:parasite:flow"]);
  });

  it("link chemistry onto a plain hydro module is blocked with a reason", () => {
    const ops = makeOps();
    // SPEC.flow is a PLAIN hydro: chemistry cannot parasite onto it
    // (no multi-species handling) — mirroring the C++ throw.
    render(<DiagramView spec={SPEC} ops={ops} />);
    fireEvent.click(screen.getAllByText("link")[1]);
    const btn = screen.getByText("+ chem.parasite");
    expect(btn).toBeDisabled();
    expect(
      screen.getByText(/has no multi-species handling/),
    ).toBeInTheDocument();
    expect(ops.calls).toEqual([]);
  });

  it("chemistry <-> post pairing offers the chain wiring instead", () => {
    const ops = makeOps();
    // The user's chain: chem_hydro -> post (turbulence) -> chemistry.
    // chemistry reads the post-processed state: it must parasite the
    // host AND run after post. No direct slot exists between post and
    // chemistry, so the dialog offers exactly that wiring.
    const spec: Spec = {
      version: 1,
      meta: {},
      sections: {
        mesh: { n_cell_global: [64, 64, 1] },
        cycle: { t_lim: 0.2 },
        "module.flow": { type: "chem_hydro", order: 0 },
        "module.sg": { type: "post", order: 1 },
        "module.chem": { type: "chemistry", order: 2 },
        "coupling.sg": { dyn: "flow" },
      },
    };
    render(<DiagramView spec={spec} ops={ops} />);
    // link on the chemistry node, pick the post module as the peer
    fireEvent.click(screen.getAllByText("link")[2]); // chem
    fireEvent.change(screen.getAllByRole("combobox")[1], {
      target: { value: "sg" },
    });
    // the direct slot button is blocked (post is no host)...
    expect(screen.getByText("+ chem.parasite")).toBeDisabled();
    // ...but the chain wiring is offered and committed
    fireEvent.click(screen.getByText("+ chem after sg (host flow)"));
    expect(ops.calls).toEqual(["chainModule:chem:flow:sg"]);
  });

  it("renders edges by relation kind: slots flow sideways, parasite vertical", () => {
    // SPEC couples chem (parasite) to flow: a PARASITE edge renders
    // host bottom -> parasite bottom by default (auto-generated edges
    // avoid top/bottom crossings), dashed class.
    const g = specToGraph(SPEC);
    const par = flowEdges(g);
    expect(par.length).toBe(1);
    expect(par[0].source).toBe("module:flow"); // host
    expect(par[0].sourceHandle).toBe("bot-out");
    expect(par[0].target).toBe("module:chem"); // parasite declarer
    expect(par[0].targetHandle).toBe("bot-in");
    expect(par[0].className).toContain("parasite");
    expect(par[0].id).toContain("cpl:chem:parasite:flow");

    // a slot coupling (post.dyn = flow) renders as an execution-flow
    // edge: provider right -> declarer left, solid.
    const s: Spec = structuredClone(SPEC);
    s.sections["module.post"] = { type: "post", order: 2 };
    s.sections["coupling.post"] = { dyn: "flow" };
    const edges = flowEdges(specToGraph(s));
    const dyn = edges.find((e) => e.id.includes(":dyn:"));
    expect(dyn?.source).toBe("module:flow");
    expect(dyn?.sourceHandle).toBe("out");
    expect(dyn?.target).toBe("module:post");
    expect(dyn?.targetHandle).toBe("in");
    expect(dyn?.className).toBe("gedge");
  });

  it("parasite edges attach at the drawn handle positions", () => {
    // the user dragged flow's TOP handle to chem's BOTTOM handle:
    // the rendered edge must use exactly those points
    const s: Spec = structuredClone(SPEC);
    s.meta = {
      edge_ends: { "cpl:chem:parasite:flow": { src: "top", tgt: "bot" } },
    };
    const par = flowEdges(specToGraph(s)).filter((e) => e.id.includes("parasite"));
    expect(par[0].sourceHandle).toBe("top-out"); // host side
    expect(par[0].targetHandle).toBe("bot-in"); // parasite side
  });

  it("any horizontal pair can be sequenced by execution order", () => {
    // post <-> chemistry share the proxy field state: no slot connects
    // them, but the user can still express the dependency — the
    // ordering button is always offered and the drawn edge renders
    const ops = makeOps();
    const spec: Spec = {
      version: 1,
      meta: {},
      sections: {
        mesh: { n_cell_global: [64, 64, 1] },
        cycle: { t_lim: 0.2 },
        "module.flow": { type: "chem_hydro", order: 0 },
        "module.sg": { type: "post", order: 1 },
        "module.chem": { type: "chemistry", order: 2 },
        "coupling.sg": { dyn: "flow" },
        "coupling.chem": { parasite: "flow" },
      },
    };
    render(<DiagramView spec={spec} ops={ops} />);
    fireEvent.click(screen.getAllByText("link")[2]); // chem
    fireEvent.change(screen.getAllByRole("combobox")[1], {
      target: { value: "sg" },
    });
    // the generic ordering button is available despite no slots
    fireEvent.click(screen.getByText("+ chem after sg"));
    expect(ops.calls).toEqual(["orderAfter:chem:sg"]);
  });

  it("drawn order edges render and outlive round trips", () => {
    const s: Spec = structuredClone(SPEC);
    s.meta = { order_edges: [{ from: "chem", to: "flow" }] };
    const edges = flowEdges(specToGraph(s)).filter((e) =>
      e.id.includes("ord:"),
    );
    // upstream (flow) right handle -> downstream (chem) left handle
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("module:flow");
    expect(edges[0].sourceHandle).toBe("out");
    expect(edges[0].target).toBe("module:chem");
    expect(edges[0].targetHandle).toBe("in");
    expect(edges[0].label).toBe("after");
  });
});
