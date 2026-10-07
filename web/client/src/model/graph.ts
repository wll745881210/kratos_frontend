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
  id: string; // "cpl:<fromRole>:<key>:<toRole>"
  fromId: string;
  toId: string;
  fromRole: string;
  toRole: string;
  key: string; // "parasite" or slot name
  parasite: boolean;
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
        edges.push({
          id: `cpl:${fromRole}:${key}:${toRole}`,
          fromId: moduleNodeId(fromRole),
          toId: moduleNodeId(toRole),
          fromRole,
          toRole,
          key,
          parasite: key === "parasite",
        });
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Graph mutations (operate in place on an already-cloned Spec)
// ---------------------------------------------------------------------------

export function addModule(s: Spec, role: string, type: string): void {
  role = role.trim();
  if (!role || role === CPL || role.includes(".")) return;
  if (RESERVED_ROLES.includes(role)) return; // container hard error
  const name = moduleSection(role);
  if (name in s.sections) return;
  s.sections[name] = { type };
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

export function removeCoupling(
  s: Spec,
  fromRole: string,
  key: string,
  toRole?: string,
): void {
  const name = couplingSection(fromRole);
  const sec = s.sections[name];
  if (!sec || !(key in sec)) return;
  if (key === "parasite" || toRole === undefined) {
    delete sec[key];
  } else {
    const rest = asStringList(sec[key]).filter((r) => r !== toRole);
    if (rest.length === 0) delete sec[key];
    else sec[key] = rest;
  }
  if (Object.keys(sec).length === 0) delete s.sections[name];
}
