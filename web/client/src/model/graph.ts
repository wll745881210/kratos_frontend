// Pure Spec <-> diagram graph model. No React / React Flow imports here so
// the whole module is unit-testable in isolation.
//
// Conventions (mirrors usr_ext/universal/registry.h):
//   [module.<role>]  type = hydro|mhd|... ; optional order (int); dotted keys
//                    are role-scoped par overrides (not shown on the diagram)
//   [coupling.<role>] parasite = <role> | <slot> = <role> [<role>...]
// Bare [module] / [coupling] are treated as role "module" / "coupling".

import type { Spec, Value } from "./types";

// Module types registered in usr_ext/universal/usr.cpp. Should eventually
// come from generated bindings (make bindings); keep in sync manually.
export const MODULE_TYPES = [
  "hydro",
  "mhd",
  "multigrid",
  "chemistry",
  "chem_hydro",
] as const;

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
  const name = moduleSection(role);
  if (name in s.sections) return;
  s.sections[name] = { type };
}

export function removeModule(s: Spec, role: string): void {
  delete s.sections[moduleSection(role)];
  delete s.sections[couplingSection(role)];
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
