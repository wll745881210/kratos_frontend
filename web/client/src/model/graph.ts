// Pure Spec <-> diagram graph model. No React / React Flow imports here so
// the whole module is unit-testable in isolation.
//
// Conventions (mirrors usr_ext/universal/registry.h + univ_mesh.h):
//   [module.<role>]  type = hydro|mhd|... ; optional order (int); ONLY
//                    type/order keys (dotted params are a hard error)
//   [coupling.<role>] parasite = <role> | <slot> = <role> [<role>...]
//   [R.<section>]    role-scoped module parameters: the container copies
//                    the input, strips the "R." prefix, and the module's
//                    read()/init() see the native section name.
// Bare [module] / [coupling] are treated as the empty role "".

import type { Spec, Value } from "./types";

// Module types registered in usr_ext/universal/usr.cpp. Static fallback
// for when /api/blocklib is unreachable; the server copy is authoritative.
export const MODULE_TYPES = [
  "hydro",
  "mhd",
  "multigrid",
  "chemistry",
  "chem_hydro",
  "post",
] as const;

// Native par sections each module type consumes (bindings._MODULE_TYPES).
export const MODULE_SECTIONS: Record<string, string[]> = {
  hydro: ["dynamics", "init", "ic.*"],
  mhd: ["dynamics", "init", "ic.*"],
  chem_hydro: ["dynamics", "init", "ic.*", "species_init"],
  chemistry: ["chemistry"],
  multigrid: ["multigrid"],
  post: ["post", "post.cooling", "post.turb"],
};

// Short pickers' labels: make multi-feature types discoverable
// (turbulence/cooling live INSIDE the post module, not as own types).
export const MODULE_LABELS: Record<string, string> = {
  hydro: "hydro",
  mhd: "mhd",
  chem_hydro: "chem_hydro",
  chemistry: "chemistry",
  multigrid: "multigrid",
  post: "post (cooling · turbulence · chemistry)",
};

/** Does this module type read [ic.*] regions? */
export const isIcType = (type: string): boolean =>
  (MODULE_SECTIONS[type] ?? []).includes("ic.*");

// Outbound coupling slots per module type (bindings._COUPLINGS);
// "parasite" is container-handled (exclusive, single target).
export const COUPLING_SLOTS: Record<string, string[]> = {
  chemistry: ["parasite"],
  post: ["dyn"],
};

// Allowed TARGET module types per (declarer type, slot), mirroring the
// C++ container's hard errors: chemistry's parasite binding (q_che)
// exists only on the multi-species dynamics flavors, and post's dyn
// slot needs a dynamics module. Mirrors registry.h / post_t::init.
export const SLOT_TARGET_TYPES: Record<string, Record<string, string[]>> = {
  chemistry: { parasite: ["chem_hydro", "chem_mhd"] },
  post: { dyn: ["hydro", "mhd", "chem_hydro", "chem_mhd"] },
};

const SLOT_TARGET_WHY: Record<string, string> = {
  "chemistry.parasite":
    "has no multi-species handling — chemistry must parasite onto chem_hydro/chem_mhd",
  "post.dyn": "is not a dynamics module — post needs the flow field",
};

/** null = no constraint known (not blocked); string = human reason.
 * `targets` defaults to the local mirror; callers that hold a blocklib
 * pass `blocklib.slot_targets` so the server stays authoritative. */
export function slotTargetProblem(
  declType: string,
  slot: string,
  tgtType: string,
  targets: Record<string, Record<string, string[]>> = SLOT_TARGET_TYPES,
): string | null {
  const allowed = targets[declType]?.[slot];
  if (!allowed || !tgtType || allowed.includes(tgtType)) return null;
  return (
    `'${tgtType}' ` +
    (SLOT_TARGET_WHY[`${declType}.${slot}`] ??
      `is not an allowed target for ${declType}.${slot}`)
  );
}

/** Hosts a chemistry module may parasite onto, discovered from the
 * peer the user dragged from/to: the peer itself (if multi-species),
 * the dynamics modules the peer is coupled to, then any other
 * chem_hydro/chem_mhd module. Ordered by relevance, deduped. */
export function parasiteHostCandidates(
  s: Spec,
  chemRole: string,
  peer: string,
): string[] {
  const out: string[] = [];
  const push = (r: string) => {
    if (r && r !== chemRole && !out.includes(r)) out.push(r);
  };
  const isHost = (r: string) => {
    const t = moduleType(s, r);
    return t === "chem_hydro" || t === "chem_mhd";
  };
  if (peer && isHost(peer)) push(peer);
  const cpl = s.sections[couplingSection(peer)];
  if (cpl) {
    for (const val of Object.values(cpl)) {
      for (const to of asStringList(val)) {
        if (isHost(to.trim())) push(to.trim());
      }
    }
  }
  for (const name of Object.keys(s.sections)) {
    if (!isModuleSection(name)) continue;
    const role = roleOf(name, MOD);
    if (isHost(role)) push(role);
  }
  return out;
}

// Role names the container rejects (registry.h reserved set): once
// [R.<sec>] is remapped they would collide with native sections.
export const RESERVED_ROLES: string[] = [
  "module", "coupling", "device", "unit",
  "mesh", "boundary", "cycle", "file",
  "init", "ic", "bc", "species_init",
  "dynamics", "chemistry", "multigrid", "post", "cooling",
];

// Core (non-module) sections shown as fixed nodes.
export const CORE_SECTIONS = [
  "device",
  "unit",
  "mesh",
  "boundary",
  "cycle",
] as const;

export interface GNode {
  id: string; // "module:<role>" | "core:<section>"
  kind: "core" | "module";
  section: string; // par section name this node represents (jump target)
  role: string; // module role (== section for core nodes)
  type?: string; // module type
  order?: number; // explicit execution order (undefined = lexicographic)
  missing?: boolean; // coupling target with no [module.<role>] section
}

export interface GEdge {
  id: string; // "cpl:<fromRole>:<key>:<toRole>" | "ord:<from>:<to>" | "chain:<chem>:<latest>"
  fromId: string;
  toId: string;
  fromRole: string;
  toRole: string;
  key: string; // "parasite", slot name, "ord" (drawn order edge) or "chain" (synthesized)
  parasite: boolean;
  /** Parasite-edge attachment points (vertical handles), from the
   * user's drag (persisted in spec.meta.edge_ends): src = host side,
   * tgt = parasite side. Absent (auto-generated) -> both "bot". */
  srcEnd?: "top" | "bot";
  tgtEnd?: "top" | "bot";
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

export const moduleNodeId = (role: string) => `module:${role}`;
export const coreNodeId = (section: string) => `core:${section}`;

/** Type of a declared module role ("" = missing type). */
export function moduleType(s: Spec, role: string): string {
  const sec = s.sections[moduleSection(role)];
  return sec ? String(sec.type ?? "") : "";
}

const MOD = "module";
const CPL = "coupling";

export function isModuleSection(name: string): boolean {
  return name === MOD || name.startsWith(MOD + ".");
}
export function isCouplingSection(name: string): boolean {
  return name === CPL || name.startsWith(CPL + ".");
}
export function roleOf(name: string, base: string): string {
  // matches registry.h: bare [module]/[coupling] map to the empty role,
  // which is how the two bare sections pair up.
  return name === base ? "" : name.slice(base.length + 1);
}
export const moduleSection = (role: string) =>
  role === "" ? MOD : `${MOD}.${role}`;
export const couplingSection = (role: string) =>
  role === "" ? CPL : `${CPL}.${role}`;

// ---------------------------------------------------------------------------
// Role-scoped sections [R.<native>]
// ---------------------------------------------------------------------------

/** Roles declared via [module] / [module.<role>] sections. */
export function declaredRoles(s: Spec): string[] {
  const roles: string[] = [];
  for (const name of Object.keys(s.sections)) {
    if (isModuleSection(name)) roles.push(roleOf(name, MOD));
  }
  return roles;
}

/** First dotted token ("flow" of "flow.ic.left"); "" if no dot. */
export function rolePrefixOf(name: string): string {
  const dot = name.indexOf(".");
  return dot <= 0 ? "" : name.slice(0, dot);
}

/** Section name after the role prefix ("ic.left" of "flow.ic.left"). */
export function stripRole(name: string): string {
  const dot = name.indexOf(".");
  return dot <= 0 ? name : name.slice(dot + 1);
}

/** True for [R.<sec>] where R is a declared module role. */
export function isRoleSection(
  name: string,
  roles: string[] | Set<string>,
): boolean {
  if (isModuleSection(name) || isCouplingSection(name)) return false;
  const prefix = rolePrefixOf(name);
  if (!prefix) return false;
  return typeof (roles as Set<string>).has === "function"
    ? (roles as Set<string>).has(prefix)
    : (roles as string[]).includes(prefix);
}

/** All sections scoped to a role, native names preserved (sorted). */
export function roleSections(s: Spec, role: string): string[] {
  const pref = role === "" ? "" : role + ".";
  return Object.keys(s.sections)
    .filter((n) => n.startsWith(pref) && n.length > pref.length)
    .sort();
}

/** Does a native section name match a module pattern ("ic.*" etc)? */
export function nativeMatches(native: string, pattern: string): boolean {
  return pattern.endsWith(".*")
    ? native.startsWith(pattern.slice(0, -2))
    : native === pattern;
}

/** Native sections of a module type not yet present under a role. */
export function missingRoleSections(s: Spec, role: string, type: string): string[] {
  const have = new Set(roleSections(s, role));
  const patterns = MODULE_SECTIONS[type] ?? [];
  const out: string[] = [];
  for (const p of patterns) {
    if (p.endsWith(".*")) continue; // ic.* regions are dynamic
    if (!have.has(role === "" ? p : `${role}.${p}`)) out.push(p);
  }
  return out;
}

// --- IC regions ([ic.<region>] native, [R.ic.<region>] scoped) ---

export function icRegionSection(role: string, region: string): string {
  return role === "" ? `ic.${region}` : `${role}.ic.${region}`;
}

export function icRegions(s: Spec, role: string): string[] {
  const pref = role === "" ? "ic." : `${role}.ic.`;
  return Object.keys(s.sections)
    .filter((n) => n.startsWith(pref) && n.length > pref.length)
    .map((n) => n.slice(pref.length))
    .sort();
}

export function addIcRegion(s: Spec, role: string, region: string): void {
  region = region.trim();
  if (!region || role.includes(".")) return;
  const name = icRegionSection(role, region);
  if (!(name in s.sections)) s.sections[name] = {};
}

export function removeIcRegion(s: Spec, role: string, region: string): void {
  delete s.sections[icRegionSection(role, region)];
}

/** Species channel keys ("x.H2") present in an IC region section. */
export function speciesChannelKeys(sec: Record<string, Value>): string[] {
  return Object.keys(sec).filter((k) => k.startsWith("x."));
}

function asStringList(v: Value | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

// ---------------------------------------------------------------------------
// Spec -> Graph
// ---------------------------------------------------------------------------

export function specToGraph(spec: Spec): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const moduleRoles = new Set<string>();
  // user-drawn parasite attachment points (spec.meta.edge_ends)
  const eEnds = readEdgeEnds(spec);

  for (const name of Object.keys(spec.sections)) {
    if (!isModuleSection(name)) continue;
    const role = roleOf(name, MOD);
    moduleRoles.add(role);
    const sec = spec.sections[name];
    const order = sec.order;
    nodes.push({
      id: moduleNodeId(role),
      kind: "module",
      section: name,
      role,
      type: sec.type !== undefined ? String(sec.type) : undefined,
      order:
        typeof order === "number"
          ? order
          : order !== undefined
            ? Number(order)
            : undefined,
    });
  }

  for (const core of CORE_SECTIONS) {
    if (!(core in spec.sections)) continue;
    nodes.push({
      id: coreNodeId(core),
      kind: "core",
      section: core,
      role: core,
    });
  }

  const ensureNode = (role: string) => {
    if (moduleRoles.has(role)) return;
    moduleRoles.add(role);
    nodes.push({
      id: moduleNodeId(role),
      kind: "module",
      section: moduleSection(role),
      role,
      missing: true,
    });
  };

  for (const name of Object.keys(spec.sections)) {
    if (!isCouplingSection(name)) continue;
    const fromRole = roleOf(name, CPL);
    if (!moduleRoles.has(fromRole)) ensureNode(fromRole); // ghost if needed
    const sec = spec.sections[name];
    for (const [key, val] of Object.entries(sec)) {
      for (const toRole of asStringList(val)) {
        if (!toRole.trim()) continue;
        ensureNode(toRole);
        // attachment points for parasite edges: the user's drag choice
        // (spec.meta.edge_ends, set when the connection was drawn),
        // else the auto-generated bottom-to-bottom default
        const ends = eEnds?.[edgeIdFor(fromRole, key, toRole)];
        edges.push({
          id: `cpl:${fromRole}:${key}:${toRole}`,
          fromId: moduleNodeId(fromRole),
          toId: moduleNodeId(toRole),
          fromRole,
          toRole,
          key,
          parasite: key === "parasite",
          ...(key === "parasite" && ends
            ? { srcEnd: ends.src, tgtEnd: ends.tgt }
            : {}),
        });
      }
    }
  }

  // Chemistry reads the shared field state at its own order: every
  // module of the host's family running between the host and the
  // chemistry module processes the data it will read. Render that
  // execution chain as a solid flow edge from the LATEST such
  // processor (e.g. post -> chemistry); the parasite binding itself
  // stays on the vertical dashed edge to the host. Explicitly drawn
  // order edges take precedence over this synthesis (no duplicates).
  const ordFroms = new Map<string, Set<string>>();
  for (const o of readOrderEdges(spec)) {
    let set = ordFroms.get(o.to);
    if (!set) ordFroms.set(o.to, (set = new Set()));
    set.add(o.from);
  }
  const declared = nodes
    .filter((n) => n.kind === "module" && !n.missing)
    .map((n) => n.role);
  const effOrder: Record<string, number> = {};
  let rank = 0;
  for (const role of [...declared].sort()) {
    const node = nodes.find(
      (n) => n.kind === "module" && n.role === role,
    );
    const o = node?.order;
    effOrder[role] = Number.isFinite(o) ? (o as number) : rank;
    rank += 1;
  }
  const hostFamily = (host: string): string[] => {
    const fam: string[] = [host];
    for (const name of Object.keys(spec.sections)) {
      if (!isCouplingSection(name)) continue;
      const from = roleOf(name, CPL);
      if (from === host) continue;
      const coupled = Object.values(spec.sections[name]).some((val) =>
        asStringList(val)
          .map((t) => t.trim())
          .includes(host),
      );
      if (coupled && !fam.includes(from)) fam.push(from);
    }
    return fam;
  };
  for (const node of nodes) {
    if (node.kind !== "module" || node.type !== "chemistry") continue;
    const host = asStringList(
      spec.sections[couplingSection(node.role)]?.parasite,
    )
      .map((t) => t.trim())
      .find((t) => t in effOrder);
    if (!host || host === node.role) continue;
    const preds = hostFamily(host).filter(
      (m) =>
        m !== node.role && m in effOrder && effOrder[m] < effOrder[node.role],
    );
    if (!preds.length) continue;
    const latest = preds.reduce((a, b) => (effOrder[a] > effOrder[b] ? a : b));
    if (latest === host) continue;
    // an explicitly drawn order edge already shows this dependency
    if (ordFroms.get(latest)?.has(node.role)) continue;
    edges.push({
      id: `chain:${node.role}:${latest}`,
      fromId: moduleNodeId(node.role),
      toId: moduleNodeId(latest),
      fromRole: node.role,
      toRole: latest,
      key: "chain",
      parasite: false,
    });
  }

  // drawn execution-order edges: "from runs after to" — the user's
  // expressed dependency; the par-level truth is the order values
  const ords = readOrderEdges(spec);
  for (const o of ords) {
    if (!(o.from in effOrder) || !(o.to in effOrder)) continue;
    edges.push({
      id: orderEdgeId(o.from, o.to),
      fromId: moduleNodeId(o.from),
      toId: moduleNodeId(o.to),
      fromRole: o.from,
      toRole: o.to,
      key: "ord",
      parasite: false,
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Graph mutations (operate in place on an already-cloned Spec)
// ---------------------------------------------------------------------------

export function addModule(
  s: Spec,
  role: string,
  type: string,
): string | null {
  const r = role.trim();
  if (!r) return "empty role name";
  if (r.includes(".")) return "role names cannot contain '.'";
  if (RESERVED_ROLES.includes(r))
    return `'${r}' is a reserved section name (collides with a native section)`;
  const name = moduleSection(r);
  if (name in s.sections) return `module '${r}' already exists`;
  s.sections[name] = { type };
  return null;
}

// Why a proposed module role would be rejected, or null when valid.
// Mirrors addModule's guards (the container's hard errors) so the
// toolbar can disable the button and explain BEFORE the click.
export function moduleRoleProblem(
  role: string,
  existing: string[],
): string | null {
  const r = role.trim();
  if (!r) return null;
  if (r.includes(".")) return "role names cannot contain '.'";
  if (RESERVED_ROLES.includes(r))
    return `'${r}' is a reserved section name`;
  if (existing.includes(r)) return `module '${r}' already exists`;
  return null;
}

export function removeModule(s: Spec, role: string): void {
  delete s.sections[moduleSection(role)];
  delete s.sections[couplingSection(role)];
  // remove this role's scoped sections [R.<sec>] (params + IC regions)
  if (role !== "") {
    const pref = role + ".";
    for (const name of Object.keys(s.sections)) {
      if (name.startsWith(pref)) delete s.sections[name];
    }
  }
  // drop references to this role from every other coupling section
  for (const name of Object.keys(s.sections)) {
    if (!isCouplingSection(name)) continue;
    const sec = s.sections[name];
    for (const key of Object.keys(sec)) {
      if (key === "parasite") {
        if (String(sec[key]) === role) delete sec[key];
        continue;
      }
      const rest = asStringList(sec[key]).filter((r) => r !== role);
      if (rest.length === asStringList(sec[key]).length) continue;
      if (rest.length === 0) delete sec[key];
      else sec[key] = rest;
    }
    if (Object.keys(sec).length === 0) delete s.sections[name];
  }
  // forget any drawn parasite attachment points involving this role
  // (edge id format: cpl:<fromRole>:<key>:<toRole>)
  _dropEdgeEndsFor(s, (id) => {
    const parts = id.slice(4).split(":");
    return parts[0] === role || parts[2] === role;
  });
  // forget drawn order edges involving this role (either end)
  const meta = s.meta as Record<string, unknown>;
  meta.order_edges = readOrderEdges(s).filter(
    (e) => e.from !== role && e.to !== role,
  );
}

export function setModuleProp(
  s: Spec,
  role: string,
  key: "type" | "order",
  v: Value | null,
): void {
  const sec = s.sections[moduleSection(role)];
  if (!sec) return;
  if (v === null || v === "") delete sec[key];
  else sec[key] = v;
}

// key: "parasite" (exclusive) or a slot name (list of roles).
export function addCoupling(
  s: Spec,
  fromRole: string,
  key: string,
  toRole: string,
): void {
  key = key.trim();
  toRole = toRole.trim();
  if (!key || !toRole || fromRole === toRole) return;
  const name = couplingSection(fromRole);
  if (!(name in s.sections)) s.sections[name] = {};
  const sec = s.sections[name];
  if (key === "parasite") {
    sec.parasite = toRole;
    return;
  }
  const list = asStringList(sec[key]);
  if (!list.includes(toRole)) list.push(toRole);
  sec[key] = list;
}

/** Attachment points a parasite edge was drawn with. src = host side,
 * tgt = parasite (declarer) side. */
export interface EdgeEnds {
  src: "top" | "bot";
  tgt: "top" | "bot";
}

export function edgeIdFor(fromRole: string, key: string, toRole: string) {
  return `cpl:${fromRole}:${key}:${toRole}`;
}

function readEdgeEnds(s: Spec): Record<string, EdgeEnds> {
  const raw = (s.meta as Record<string, unknown>)?.edge_ends;
  return raw && typeof raw === "object" ? (raw as Record<string, EdgeEnds>) : {};
}

/** Remember the vertical handle positions a parasite coupling was
 * drawn with (persists with the project, like diagram_positions). */
export function setEdgeEnds(
  s: Spec,
  fromRole: string,
  key: string,
  toRole: string,
  ends: EdgeEnds,
): void {
  const meta = s.meta as Record<string, unknown>;
  const all = readEdgeEnds(s);
  all[edgeIdFor(fromRole, key, toRole)] = ends;
  meta.edge_ends = all;
}

function _dropEdgeEndsFor(s: Spec, pred: (id: string) => boolean): void {
  const meta = s.meta as Record<string, unknown>;
  const all = readEdgeEnds(s);
  const rest = Object.fromEntries(
    Object.entries(all).filter(([id]) => !pred(id)),
  );
  meta.edge_ends = rest;
}

/** Effective execution order: the explicit `order` when present, else
 * the lexicographic rank the container assigns (xchecks mirror). */
export function effectiveOrderOf(s: Spec, role: string): number {
  const roles = declaredRoles(s);
  let rank = 0;
  let out: number | undefined;
  for (const r of [...roles].sort()) {
    const o = Number(s.sections[moduleSection(r)]?.order);
    const v = Number.isFinite(o) ? o : rank;
    if (r === role) out = v;
    rank += 1;
  }
  return out ?? rank;
}

/** Give `role` the smallest free explicit order past `afterRole`'s
 * effective order (explicit orders must stay unique — the container
 * throws on duplicates). Modules on one mesh share the proxy field
 * state; relative order is the ONLY ordering semantics the container
 * has, so any two modules can be sequenced this way. */
export function orderAfter(s: Spec, role: string, afterRole: string): void {
  if (!role || role === afterRole) return;
  const after = effectiveOrderOf(s, afterRole);
  const cur = Number(s.sections[moduleSection(role)]?.order);
  if (Number.isFinite(cur) && cur > after) return;
  const taken = new Set<number>();
  for (const name of Object.keys(s.sections)) {
    if (!isModuleSection(name)) continue;
    const r = roleOf(name, MOD);
    if (r === role) continue;
    const o = Number(s.sections[name].order);
    if (Number.isFinite(o)) taken.add(o);
  }
  let next = Math.floor(after) + 1;
  while (taken.has(next)) next += 1;
  setModuleProp(s, role, "order", next);
}

/** Wire a chemistry module into the execution chain: parasite onto a
 * multi-species host AND run after `afterRole`, so it reads the state
 * as processed by that module (post output etc.). */
export function chainModule(
  s: Spec,
  chemRole: string,
  hostRole: string,
  afterRole: string,
): void {
  addCoupling(s, chemRole, "parasite", hostRole);
  orderAfter(s, chemRole, afterRole);
}

// ---------------------------------------------------------------------------
// Drawn execution-order edges (horizontal "A after B"). The par-level
// truth is the modules' `order` values; the edge list is project
// metadata (spec.meta.order_edges, like diagram_positions / edge_ends)
// so the diagram keeps showing the dependency the user expressed.
// ---------------------------------------------------------------------------

export interface OrderEdge {
  from: string; // downstream (runs after)
  to: string; // upstream (runs before)
}

export function orderEdgeId(from: string, to: string) {
  return `ord:${from}:${to}`;
}

export function readOrderEdges(s: Spec): OrderEdge[] {
  const raw = (s.meta as Record<string, unknown>)?.order_edges;
  if (!Array.isArray(raw)) return [];
  const out: OrderEdge[] = [];
  for (const r of raw) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      if (typeof o.from === "string" && typeof o.to === "string")
        out.push({ from: o.from, to: o.to });
    }
  }
  return out;
}

export function addOrderEdge(s: Spec, from: string, to: string): void {
  from = from.trim();
  to = to.trim();
  if (!from || !to || from === to) return;
  const meta = s.meta as Record<string, unknown>;
  const all = readOrderEdges(s);
  if (!all.some((e) => e.from === from && e.to === to)) all.push({ from, to });
  meta.order_edges = all;
}

export function removeOrderEdge(s: Spec, from: string, to: string): void {
  const meta = s.meta as Record<string, unknown>;
  const rest = readOrderEdges(s).filter(
    (e) => !(e.from === from && e.to === to),
  );
  meta.order_edges = rest;
}

export function removeCoupling(
  s: Spec,
  fromRole: string,
  key: string,
  toRole?: string,
): void {
  const name = couplingSection(fromRole);
  const sec = s.sections[name];
  if (!sec) {
    _dropEdgeEndsFor(s, (id) => id.startsWith(`cpl:${fromRole}:`));
    return;
  }
  if (key === "parasite" || toRole === undefined) {
    // forget any drawn attachment points for this declarer's edges
    _dropEdgeEndsFor(s, (id) => id.startsWith(`cpl:${fromRole}:`));
    delete sec[key];
    if (Object.keys(sec).length === 0) delete s.sections[name];
    return;
  }
  if (!(key in sec)) return;
  const rest = asStringList(sec[key]).filter((r) => r !== toRole);
  _dropEdgeEndsFor(s, (id) => id === edgeIdFor(fromRole, key, toRole));
  if (rest.length === 0) delete sec[key];
  else sec[key] = rest;
  if (Object.keys(sec).length === 0) delete s.sections[name];
}
