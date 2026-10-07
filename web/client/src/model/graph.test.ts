import { describe, expect, it } from "vitest";
import {
  addCoupling,
  addIcRegion,
  addModule,
  addOrderEdge,
  chainModule,
  declaredRoles,
  Graph,
  icRegions,
  isRoleSection,
  missingRoleSections,
  moduleRoleProblem,
  nativeMatches,
  orderAfter,
  parasiteHostCandidates,
  removeCoupling,
  removeIcRegion,
  removeModule,
  removeOrderEdge,
  rolePrefixOf,
  roleSections,
  setEdgeEnds,
  setModuleProp,
  slotTargetProblem,
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

  it("slotTargetProblem mirrors the container's target-type gates", () => {
    // chemistry parasitizes only the multi-species dynamics flavors
    expect(slotTargetProblem("chemistry", "parasite", "hydro")).toMatch(
      /no multi-species handling/,
    );
    expect(slotTargetProblem("chemistry", "parasite", "mhd")).toMatch(
      /no multi-species handling/,
    );
    expect(slotTargetProblem("chemistry", "parasite", "post")).toMatch(
      /no multi-species handling/,
    );
    expect(slotTargetProblem("chemistry", "parasite", "chem_hydro")).toBeNull();
    expect(slotTargetProblem("chemistry", "parasite", "chem_mhd")).toBeNull();
    // post.dyn needs a dynamics module
    expect(slotTargetProblem("post", "dyn", "chemistry")).toMatch(
      /not a dynamics module/,
    );
    expect(slotTargetProblem("post", "dyn", "hydro")).toBeNull();
    expect(slotTargetProblem("post", "dyn", "chem_hydro")).toBeNull();
    // unknown combos / missing info are not judged
    expect(slotTargetProblem("hydro", "anything", "post")).toBeNull();
    expect(slotTargetProblem("post", "dyn", "")).toBeNull();
  });

  it("parasiteHostCandidates discovers hosts through the peer", () => {    const s = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 2 },
      "coupling.sg": { dyn: "flow" },
    });
    // dragging post -> chemistry: the host is found via post's own
    // dyn coupling (the module that feeds it)
    expect(parasiteHostCandidates(s, "chem", "sg")).toEqual(["flow"]);
    // the peer itself when it is a multi-species dynamics module
    expect(parasiteHostCandidates(s, "chem", "flow")).toEqual(["flow"]);
    // any other enrolled chem_* module is a fallback candidate
    const s2 = spec({
      "module.a": { type: "hydro", order: 0 },
      "module.b": { type: "chem_mhd", order: 1 },
      "module.chem": { type: "chemistry", order: 2 },
    });
    expect(parasiteHostCandidates(s2, "chem", "a")).toEqual(["b"]);
    // plain modules with no chem_* anywhere: no host to offer
    const s3 = spec({
      "module.flow": { type: "hydro", order: 0 },
      "module.chem": { type: "chemistry", order: 1 },
    });
    expect(parasiteHostCandidates(s3, "chem", "flow")).toEqual([]);
  });

  it("synthesizes the chemistry chain edge from the latest processor", () => {
    const s = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 2 },
      "coupling.sg": { dyn: "flow" },
      "coupling.chem": { parasite: "flow" },
    });
    const g = specToGraph(s);
    // execution chain: post processed the fields chemistry will read
    const e = g.edges.find((x) => x.id === "chain:chem:sg");
    expect(e).toBeDefined();
    expect(e?.fromRole).toBe("chem"); // declarer = chemistry
    expect(e?.toRole).toBe("sg"); // provider = post
    expect(e?.parasite).toBe(false);
  });

  it("no chain edge without a parasite host or with an early order", () => {
    // no parasite binding -> nothing to synthesize from
    const noHost = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 2 },
      "coupling.sg": { dyn: "flow" },
    });
    expect(specToGraph(noHost).edges.find((x) => x.id.startsWith("chain:"))).toBeUndefined();
    // chemistry BEFORE post: latest predecessor is the host itself ->
    // the vertical parasite edge covers it, no horizontal chain edge
    const early = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 2 },
      "module.chem": { type: "chemistry", order: 1 },
      "coupling.sg": { dyn: "flow" },
      "coupling.chem": { parasite: "flow" },
    });
    expect(specToGraph(early).edges.find((x) => x.id.startsWith("chain:"))).toBeUndefined();
  });

  it("chainModule parasites the host and orders past the peer", () => {
    const s = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 0 },
      "coupling.sg": { dyn: "flow" },
    });
    chainModule(s, "chem", "flow", "sg");
    expect(s.sections["coupling.chem"]).toEqual({ parasite: "flow" });
    // smallest free explicit order past sg(1): 2
    expect(s.sections["module.chem"].order).toBe(2);
    // already past the peer -> order untouched
    const s2 = structuredClone(s);
    chainModule(s2, "chem", "flow", "sg");
    expect(s2.sections["module.chem"].order).toBe(2);
  });

  it("edge ends persist, stamp the graph, and clean up on removal", () => {
    const s = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.chem": { type: "chemistry", order: 1 },
      "coupling.chem": { parasite: "flow" },
    });
    // default: auto-generated parasite edges carry no ends
    expect(specToGraph(s).edges[0].srcEnd).toBeUndefined();
    // drawn from flow's top to chem's bottom -> remembered in meta
    setEdgeEnds(s, "chem", "parasite", "flow", { src: "top", tgt: "bot" });
    const e = specToGraph(s).edges[0];
    expect(e.srcEnd).toBe("top");
    expect(e.tgtEnd).toBe("bot");
    // removing the coupling forgets the drawn positions
    removeCoupling(s, "chem", "parasite");
    const meta = s.meta as { edge_ends?: Record<string, unknown> };
    expect(meta.edge_ends).toEqual({});
    // removing a module forgets entries on either side of its edges
    const s2 = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.chem": { type: "chemistry", order: 1 },
      "coupling.chem": { parasite: "flow" },
    });
    setEdgeEnds(s2, "chem", "parasite", "flow", { src: "bot", tgt: "top" });
    removeModule(s2, "chem");
    const meta2 = s2.meta as { edge_ends?: Record<string, unknown> };
    expect(meta2.edge_ends).toEqual({});
  });

  it("orderAfter sequences any pair via the smallest free order", () => {
    const s = spec({
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 0 },
    });
    orderAfter(s, "chem", "sg");
    // smallest free explicit order past sg(1)
    expect(s.sections["module.chem"].order).toBe(2);
    // already after: untouched
    const s2 = structuredClone(s);
    orderAfter(s2, "chem", "sg");
    expect(s2.sections["module.chem"].order).toBe(2);
    // same module: no-op
    orderAfter(s2, "sg", "sg");
    expect(s2.sections["module.sg"].order).toBe(1);
  });

  it("order edges persist in meta, render, dedup chain, clean up", () => {
    const base = {
      "module.flow": { type: "chem_hydro", order: 0 },
      "module.sg": { type: "post", order: 1 },
      "module.chem": { type: "chemistry", order: 2 },
      "coupling.sg": { dyn: "flow" },
      "coupling.chem": { parasite: "flow" },
    };
    // without drawn edges: the chemistry chain edge is synthesized
    const g0 = specToGraph(spec(base));
    expect(g0.edges.find((e) => e.id === "chain:chem:sg")).toBeDefined();
    // an explicit order edge replaces the synthesis (no duplicate)
    const s = spec(base);
    addOrderEdge(s, "chem", "sg");
    const g = specToGraph(s);
    expect(g.edges.find((e) => e.id === "chain:chem:sg")).toBeUndefined();
    const ord = g.edges.find((e) => e.id === "ord:chem:sg");
    expect(ord).toMatchObject({ fromRole: "chem", toRole: "sg" });
    // persisted in meta, idempotent
    const meta = s.meta as { order_edges?: { from: string; to: string }[] };
    expect(meta.order_edges).toEqual([{ from: "chem", to: "sg" }]);
    // removal forgets the drawn edge; the derived chain synthesis
    // takes over again (par-level truth is untouched)
    removeOrderEdge(s, "chem", "sg");
    expect(meta.order_edges).toEqual([]);
    expect(
      specToGraph(s).edges.find((e) => e.id === "chain:chem:sg"),
    ).toBeDefined();
    // removing a module drops its order edges (either end)
    const s2 = spec(base);
    addOrderEdge(s2, "chem", "sg");
    removeModule(s2, "sg");
    const meta2 = s2.meta as { order_edges?: { from: string; to: string }[] };
    expect(meta2.order_edges).toEqual([]);
  });
});
