import { describe, expect, it } from "vitest";
import {
  addCoupling,
  addModule,
  Graph,
  removeCoupling,
  removeModule,
  setModuleProp,
  specToGraph,
} from "./graph";
import type { Spec } from "./types";

function spec(sections: Spec["sections"]): Spec {
  return { version: 1, meta: {}, sections };
}

const SAMPLE = spec({
  mesh: { n_cell_global: [64, 64, 1] },
  boundary: { kinds: ["fre", "fre", "fre", "fre", "fre", "fre"] },
  cycle: { t_lim: 0.2 },
  "module.mg": { type: "multigrid", order: 0 },
  "module.flow": { type: "hydro", order: 1, "dynamics.cfl": 0.4 },
  "module.chem": { type: "chemistry", order: 2 },
  "coupling.chem": { parasite: "flow", sources: ["mg"] },
});

describe("specToGraph", () => {
  it("builds module + core nodes and coupling edges", () => {
    const g = specToGraph(SAMPLE);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      "core:boundary",
      "core:cycle",
      "core:mesh",
      "module:chem",
      "module:flow",
      "module:mg",
    ]);
    const paras = g.edges.filter((e) => e.parasite);
    expect(paras).toHaveLength(1);
    expect(paras[0]).toMatchObject({
      fromRole: "chem",
      toRole: "flow",
      key: "parasite",
    });
    const slots = g.edges.filter((e) => !e.parasite);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      fromRole: "chem",
      toRole: "mg",
      key: "sources",
    });
  });

  it("creates ghost nodes for coupling targets without a module", () => {
    const g = specToGraph(
      spec({ "coupling.a": { parasite: "ghost" }, "module.a": { type: "hydro" } }),
    );
    const ghost = g.nodes.find((n) => n.role === "ghost");
    expect(ghost?.missing).toBe(true);
    expect(g.edges[0].toId).toBe("module:ghost");
  });

  it("handles bare [module] / [coupling] sections (empty role)", () => {
    const g = specToGraph(
      spec({ module: { type: "hydro" }, coupling: { parasite: "other" } }),
    );
    expect(g.nodes.some((n) => n.role === "" && !n.missing)).toBe(true);
    expect(g.edges[0].fromRole).toBe("");
    expect(g.edges[0].toRole).toBe("other");
  });
});

describe("mutations", () => {
  it("addModule refuses bad roles and duplicates", () => {
    const s = spec({});
    addModule(s, "flow", "hydro");
    expect(s.sections["module.flow"]).toEqual({ type: "hydro" });
    addModule(s, "flow", "mhd"); // duplicate: no-op
    expect(s.sections["module.flow"]).toEqual({ type: "hydro" });
    addModule(s, "bad.role", "hydro");
    expect(Object.keys(s.sections)).toEqual(["module.flow"]);
  });

  it("setModuleProp sets and clears type/order", () => {
    const s = spec({ "module.f": { type: "hydro" } });
    setModuleProp(s, "f", "order", 2);
    expect(s.sections["module.f"].order).toBe(2);
    setModuleProp(s, "f", "order", null);
    expect("order" in s.sections["module.f"]).toBe(false);
    setModuleProp(s, "f", "type", "mhd");
    expect(s.sections["module.f"].type).toBe("mhd");
  });

  it("addCoupling parasite is exclusive; slots accumulate", () => {
    const s = spec({ "module.a": { type: "chemistry" } });
    addCoupling(s, "a", "parasite", "f1");
    addCoupling(s, "a", "parasite", "f2"); // replaces
    expect(s.sections["coupling.a"].parasite).toBe("f2");
    addCoupling(s, "a", "sources", "m1");
    addCoupling(s, "a", "sources", "m2");
    addCoupling(s, "a", "sources", "m1"); // no dup
    expect(s.sections["coupling.a"].sources).toEqual(["m1", "m2"]);
  });

  it("removeCoupling drops one target and prunes empty sections", () => {
    const s = spec({
      "module.a": { type: "chemistry" },
      "coupling.a": { sources: ["m1", "m2"] },
    });
    removeCoupling(s, "a", "sources", "m1");
    expect(s.sections["coupling.a"].sources).toEqual(["m2"]);
    removeCoupling(s, "a", "sources", "m2");
    expect("coupling.a" in s.sections).toBe(false);
  });

  it("removeModule removes its module+coupling sections and references", () => {
    const s = spec({
      "module.flow": { type: "hydro" },
      "module.chem": { type: "chemistry" },
      "module.mg": { type: "multigrid" },
      "coupling.chem": { parasite: "flow", sources: ["mg", "flow"] },
      "coupling.mg": { parasite: "flow" },
    });
    removeModule(s, "flow");
    expect("module.flow" in s.sections).toBe(false);
    expect(s.sections["coupling.chem"]).toEqual({ sources: ["mg"] });
    expect("coupling.mg" in s.sections).toBe(false); // parasite removed -> empty
  });

  it("round-trip: graph reflects mutations", () => {
    const s = spec({ mesh: {} });
    addModule(s, "flow", "hydro");
    addModule(s, "mg", "multigrid");
    addCoupling(s, "flow", "gravity", "mg");
    const g: Graph = specToGraph(s);
    expect(g.nodes.filter((n) => n.kind === "module")).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ key: "gravity", fromRole: "flow" });
  });
});
