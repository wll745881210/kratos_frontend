import { describe, expect, it } from "vitest";
import {
  addCoupling,
  addIcRegion,
  addModule,
  declaredRoles,
  Graph,
  icRegions,
  isRoleSection,
  missingRoleSections,
  moduleRoleProblem,
  nativeMatches,
  removeCoupling,
  removeIcRegion,
  removeModule,
  rolePrefixOf,
  roleSections,
  setModuleProp,
  speciesChannelKeys,
  specToGraph,
  stripRole,
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
    expect(addModule(s, "flow", "hydro")).toBeNull();
    expect(s.sections["module.flow"]).toEqual({ type: "hydro" });
    // duplicate: no-op + error
    expect(addModule(s, "flow", "mhd")).toMatch(/already exists/);
    expect(s.sections["module.flow"]).toEqual({ type: "hydro" });
    expect(addModule(s, "bad.role", "hydro")).toMatch(/cannot contain/);
    expect(Object.keys(s.sections)).toEqual(["module.flow"]);
    // empty
    expect(addModule(s, "  ", "hydro")).toMatch(/empty/);
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

// ---------------------------------------------------------------------------
// role-scoped sections / IC regions (univ_mesh.h conventions)
// ---------------------------------------------------------------------------

const SCOPED: Spec = {
  version: 1,
  meta: {},
  sections: {
    mesh: { n_cell_global: [64, 2, 1] },
    "module.flow": { type: "hydro", order: 0 },
    "module.sg": { type: "post", order: 1 },
    "flow.dynamics": { gamma: 1.4 },
    "flow.ic.left": { mask: "x < 0.5", rho: 1 },
    "flow.ic.right": { mask: "x geq 0.5", rho: 0.125 },
    "flow.ic.left.x.H2": {},
    "coupling.sg": { dyn: "flow" },
  },
};

describe("role sections", () => {
  it("declaredRoles / rolePrefixOf / stripRole", () => {
    expect(declaredRoles(SCOPED).sort()).toEqual(["flow", "sg"]);
    expect(rolePrefixOf("flow.ic.left")).toBe("flow");
    expect(stripRole("flow.ic.left")).toBe("ic.left");
    expect(stripRole("mesh")).toBe("mesh");
  });

  it("isRoleSection only for declared roles", () => {
    const roles = declaredRoles(SCOPED);
    expect(isRoleSection("flow.dynamics", roles)).toBe(true);
    expect(isRoleSection("module.flow", roles)).toBe(false);
    expect(isRoleSection("mesh", roles)).toBe(false);
    // a native dotted section whose prefix is not a declared role
    expect(isRoleSection("post.cooling", roles)).toBe(false);
  });

  it("roleSections lists scoped sections", () => {
    expect(roleSections(SCOPED, "flow")).toEqual([
      "flow.dynamics",
      "flow.ic.left",
      "flow.ic.left.x.H2",
      "flow.ic.right",
    ]);
  });

  it("icRegions + species channels", () => {
    expect(icRegions(SCOPED, "flow")).toEqual(["left", "left.x.H2", "right"]);
    // "left.x.H2" is itself parsed as a region named "left.x.H2" --
    // species channels are KEYS, so this section is a naming trap the
    // xchecks warn about; model stays literal.
    expect(speciesChannelKeys(SCOPED.sections["flow.ic.left"])).toEqual([]);
  });

  it("missingRoleSections suggests what a module can still take", () => {
    expect(missingRoleSections(SCOPED, "flow", "hydro")).toEqual(["init"]);
    expect(missingRoleSections(SCOPED, "sg", "post")).toEqual([
      "post",
      "post.cooling",
      "post.turb",
    ]);
  });

  it("addIcRegion / removeIcRegion round-trip", () => {
    const s = structuredClone(SCOPED);
    addIcRegion(s, "flow", "midpatch");
    expect(s.sections["flow.ic.midpatch"]).toEqual({});
    removeIcRegion(s, "flow", "midpatch");
    expect(s.sections["flow.ic.midpatch"]).toBeUndefined();
  });

  it("removeModule drops role sections + couplings", () => {
    const s = structuredClone(SCOPED);
    removeModule(s, "flow");
    expect(s.sections["flow.dynamics"]).toBeUndefined();
    expect(s.sections["flow.ic.left"]).toBeUndefined();
    expect(s.sections["coupling.sg"]).toBeUndefined(); // dyn target gone
    expect(s.sections["module.flow"]).toBeUndefined();
  });

  it("addModule rejects reserved roles", () => {
    const s = structuredClone(SCOPED);
    expect(addModule(s, "post", "post")).toMatch(/reserved section name/);
    expect(s.sections["module.post"]).toBeUndefined();
    expect(addModule(s, "subgrid", "post")).toBeNull();
    expect(s.sections["module.subgrid"]).toEqual({ type: "post" });
  });

  it("moduleRoleProblem mirrors addModule guards for the toolbar", () => {
    expect(moduleRoleProblem("post", [])).toMatch(/reserved/);
    expect(moduleRoleProblem("cooling", [])).toMatch(/reserved/);
    expect(moduleRoleProblem("a.b", [])).toMatch(/cannot contain/);
    expect(moduleRoleProblem("flow", ["flow"])).toMatch(/already exists/);
    expect(moduleRoleProblem("subgrid", ["flow"])).toBeNull();
    expect(moduleRoleProblem("", ["flow"])).toBeNull(); // caller disables
  });

  it("nativeMatches patterns", () => {
    expect(nativeMatches("ic.left", "ic.*")).toBe(true);
    expect(nativeMatches("init", "init")).toBe(true);
    expect(nativeMatches("init", "ic.*")).toBe(false);
  });
});
