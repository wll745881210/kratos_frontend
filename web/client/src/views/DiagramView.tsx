// Block-diagram view of a Spec: core sections as fixed nodes, one node per
// [module.<role>], edges from [coupling.<role>] (parasite = dashed, named
// slots = solid). Purely derived from the Spec; all edits go back through
// the mutation callbacks (the Spec stays the single source of truth).
//
// React Flow is used in CONTROLLED mode, so every change it reports
// (position/select/remove) must be applied to the arrays we pass back in —
// otherwise selection (and thus the Delete key) silently stops working.
// Module nodes additionally carry explicit edit/link/delete buttons so the
// operations do not depend on keyboard shortcuts or precise handle drags.

import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  COUPLING_SLOTS,
  CORE_SECTIONS,
  type Graph,
  MODULE_LABELS,
  MODULE_TYPES,
  moduleNodeId,
  moduleRoleProblem,
  moduleType,
  specToGraph,
} from "../model/graph";
import type { Blocklib, Spec } from "../model/types";

export interface DiagramOps {
  /** returns an error message when the module was NOT added, else null */
  onAddModule: (role: string, type: string) => string | null;
  onRemoveModule: (role: string) => void;
  onAddCoupling: (fromRole: string, key: string, toRole: string) => void;
  onRemoveCoupling: (fromRole: string, key: string, toRole?: string) => void;
  /** open the in-diagram inspector for a module role */
  onInspectRole: (role: string | null) => void;
}

interface NodeData {
  label: string;
  sub?: string;
  missing?: boolean;
  core?: boolean;
  role?: string;
  section?: string;
  onEdit?: () => void;
  onLink?: () => void;
  onDelete?: () => void;
}

function KratosNode({ data }: NodeProps<NodeData>) {
  const cls = data.core
    ? "gnode core"
    : data.missing
      ? "gnode missing"
      : "gnode module";
  return (
    <div className={cls}>
      {!data.core && (
        <Handle type="target" position={Position.Left} />
      )}
      <div className="gnode-label">{data.label}</div>
      {data.sub && <div className="gnode-sub">{data.sub}</div>}
      {!data.core && !data.missing && (
        <div className="gnode-actions nodrag">
          <button
            className="nodrag"
            title="open this module's section for editing"
            onClick={(e) => {
              e.stopPropagation();
              data.onEdit?.();
            }}
          >
            edit
          </button>
          <button
            className="nodrag"
            title="add a coupling from this module"
            onClick={(e) => {
              e.stopPropagation();
              data.onLink?.();
            }}
          >
            link
          </button>
          <button
            className="nodrag"
            title="remove this module"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete?.();
            }}
          >
            delete
          </button>
        </div>
      )}
      {!data.core && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const nodeTypes = { kratos: KratosNode };

// Columnar auto-layout: core sections left, modules right (by order, then
// role). Dragging is free-form and persisted to spec.meta (M2.4).
function layout(g: Graph): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const cores = CORE_SECTIONS.filter((c) =>
    g.nodes.some((n) => n.kind === "core" && n.role === c),
  );
  const mods = g.nodes
    .filter((n) => n.kind === "module")
    .sort(
      (a, b) =>
        (a.order ?? 1e9) - (b.order ?? 1e9) || a.role.localeCompare(b.role),
    );
  const nodes: Node<NodeData>[] = [];
  cores.forEach((c, i) =>
    nodes.push({
      id: `core:${c}`,
      type: "kratos",
      position: { x: 0, y: i * 90 },
      deletable: false,
      data: { label: `[${c}]`, core: true },
    }),
  );
  mods.forEach((m, i) =>
    nodes.push({
      id: moduleNodeId(m.role),
      type: "kratos",
      position: { x: 340, y: i * 90 },
      deletable: !m.missing,
      data: {
        label: m.role === "" ? "module" : m.role,
        sub: m.missing
          ? "missing module"
          : `${m.type ?? "?"}${m.order !== undefined ? ` · order ${m.order}` : ""}`,
        missing: m.missing,
        role: m.role,
        section: m.section,
      },
    }),
  );
  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.fromId,
    target: e.toId,
    label: e.parasite ? "parasite" : e.key,
    animated: e.parasite,
    className: e.parasite ? "gedge parasite" : "gedge",
  }));
  return { nodes, edges };
}

const stripModule = (id: string) => id.replace(/^module:/, "");

export function DiagramView({
  spec,
  ops,
  positions,
  onPositions,
  blocklib,
}: {
  spec: Spec;
  ops: DiagramOps;
  /** Saved node positions (spec.meta.diagram_positions); read once at mount. */
  positions?: Record<string, { x: number; y: number }>;
  /** Called after a drag ends with the full position map (for persistence). */
  onPositions?: (p: Record<string, { x: number; y: number }>) => void;
  /** Server block library (GET /api/blocklib); constants are the fallback. */
  blocklib?: Blocklib | null;
}) {
  const types = blocklib?.modules?.length
    ? blocklib.modules.map((m) => m.type)
    : MODULE_TYPES;
  const slotsOf = (t: string): string[] =>
    blocklib?.couplings
      ? Object.keys(blocklib.couplings[t] ?? {})
      : (COUPLING_SLOTS[t] ?? []);
  const graph = useMemo(() => specToGraph(spec), [spec]);
  const { nodes: laidOut, edges } = useMemo(() => layout(graph), [graph]);
  // Local drag state; initialised from persisted positions, layout otherwise.
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(
    () => ({ ...(positions ?? {}) }),
  );
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [esel, setEsel] = useState<Set<string>>(() => new Set());
  const [newType, setNewType] = useState<string>(
    types.includes(MODULE_TYPES[0]) ? MODULE_TYPES[0] : (types[0] ?? "hydro"),
  );

  const nodes = useMemo(
    () =>
      laidOut.map((n) => {
        const canAct = !n.data.core && !n.data.missing;
        return {
          ...n,
          position: pos[n.id] ?? n.position,
          selected: sel.has(n.id),
          data: {
            ...n.data,
            onEdit: canAct
              ? () => ops.onInspectRole(n.data.role ?? "")
              : undefined,
            onLink: canAct
              ? () => {
                  setSlotName("");
                  setLinkTarget("");
                  setCouple({ source: n.data.role ?? "" });
                }
              : undefined,
            onDelete: canAct
              ? () => ops.onRemoveModule(n.data.role ?? "")
              : undefined,
          },
        };
      }),
    [laidOut, pos, sel, ops],
  );
  const edgesSel = useMemo(
    () => edges.map((e) => ({ ...e, selected: esel.has(e.id) })),
    [edges, esel],
  );

  // The coupling dialog: if `target` is given (handle drag) the peer is
  // fixed; otherwise the user picks it (link button).
  const [couple, setCouple] = useState<{ source: string; target?: string } | null>(
    null,
  );
  const [linkTarget, setLinkTarget] = useState("");
  const [slotName, setSlotName] = useState("");
  const [newRole, setNewRole] = useState("");

  const roles = useMemo(
    () => graph.nodes.filter((n) => n.kind === "module").map((n) => n.role),
    [graph],
  );
  const linkCandidates = useMemo(
    () => roles.filter((r) => r !== couple?.source),
    [roles, couple],
  );
  // Resolved coupling target: fixed after a handle drag, otherwise the
  // user's pick (defaulting to the first candidate).
  const target = couple?.target ?? (linkTarget || linkCandidates[0] || "");

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    setSlotName("");
    setLinkTarget("");
    setCouple({ source: stripModule(c.source), target: stripModule(c.target) });
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPos((p) => {
      let next = p;
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          if (next === p) next = { ...p };
          next[c.id] = c.position;
        } else if (c.type === "remove" && c.id in next) {
          if (next === p) next = { ...p };
          delete next[c.id];
        }
      }
      return next;
    });
    setSel((s) => {
      let next = s;
      for (const c of changes) {
        if (c.type === "select") {
          if (next === s) next = new Set(s);
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        } else if (c.type === "remove") {
          if (next === s) next = new Set(s);
          next.delete(c.id);
        }
      }
      return next;
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEsel((s) => {
      let next = s;
      for (const c of changes) {
        if (c.type === "select") {
          if (next === s) next = new Set(s);
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        } else if (c.type === "remove") {
          if (next === s) next = new Set(s);
          next.delete(c.id);
        }
      }
      return next;
    });
  }, []);

  const commitCouple = (fromRole: string, key: string, toRole: string) => {
    ops.onAddCoupling(fromRole, key, toRole);
    setCouple(null);
    setSlotName("");
    setLinkTarget("");
  };

  // Semantic coupling choices: slots offered by the SOURCE module's type
  // (from the block library, mirroring the C++ container).  When the
  // source has no outbound slots the direction is reversed automatically.
  const srcType = couple ? moduleType(spec, couple.source) : "";
  const tgtType = couple ? moduleType(spec, target) : "";
  const srcSlots = couple ? slotsOf(srcType) : [];
  const tgtSlots = couple ? slotsOf(tgtType) : [];

  const proposedRole = newRole.trim();
  const roleProblem = proposedRole
    ? moduleRoleProblem(proposedRole, roles)
    : null;
  const suggest: Record<string, string> = {
    post: "subgrid",
    hydro: "flow",
    mhd: "mhd_flow",
    chem_hydro: "chem",
    chemistry: "chem",
    multigrid: "mg",
  };

  return (
    <div className="diagram-wrap">
      <div className="diagram-toolbar">
        <input
          placeholder={
            proposedRole ? "new module role" : `e.g. ${suggest[newType] ?? newType}`
          }
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          spellCheck={false}
        />
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {MODULE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <button
          disabled={!proposedRole || roleProblem !== null}
          title={roleProblem ?? undefined}
          onClick={() => {
            const err = ops.onAddModule(proposedRole, newType);
            if (err) return; // normally pre-empted by the disabled state
            setNewRole("");
          }}
        >
          + module
        </button>
        <span className={roleProblem ? "hint role-error" : "hint"}>
          {roleProblem
            ? `${proposedRole}: ${roleProblem} — pick a role name like '${suggest[newType] ?? newType}'`
            : "edit opens this module's inspector · link offers valid couplings · drag handles to connect · double-click a node to inspect"}
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edgesSel}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={() => {
          if (onPositions) {
            const out: Record<string, { x: number; y: number }> = {};
            nodes.forEach((n) => {
              out[n.id] = n.position;
            });
            onPositions(out);
          }
        }}
        onNodesDelete={(ns) =>
          ns.forEach((n) => {
            if (n.id.startsWith("module:")) {
              const m = graph.nodes.find((g) => g.id === n.id);
              if (m && !m.missing) ops.onRemoveModule(m.role);
            }
          })
        }
        onEdgesDelete={(es) =>
          es.forEach((e) => {
            const ge = graph.edges.find((g) => g.id === e.id);
            if (ge) ops.onRemoveCoupling(ge.fromRole, ge.key, ge.toRole);
          })
        }
        onNodeDoubleClick={(_, n) => {
          const g = graph.nodes.find((x) => x.id === n.id);
          if (g && !g.missing && g.kind === "module") ops.onInspectRole(g.role);
        }}
        deleteKeyCode={["Delete", "Backspace"]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} />
        <Controls />
      </ReactFlow>

      {couple && (
        <div className="coupling-dialog">
          <div>
            couple <b>{couple.source || "module"}</b>{" "}
            {srcSlots.length ? "→" : "←"}{" "}
            {couple.target !== undefined ? (
              <b>{couple.target || "module"}</b>
            ) : linkCandidates.length ? (
              <select
                value={linkTarget || linkCandidates[0] || ""}
                onChange={(e) => setLinkTarget(e.target.value)}
              >
                {linkCandidates.map((r) => (
                  <option key={r} value={r}>
                    {r || "module"}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hint">no other module to couple to</span>
            )}
          </div>
          {srcSlots.length > 0 ? (
            srcSlots.map((s) => (
              <button key={s} disabled={!target} onClick={() => commitCouple(couple.source, s, target)}>
                {s === "parasite" ? "parasite" : `+ ${s}`}
              </button>
            ))
          ) : tgtSlots.length > 0 && target ? (
            <>
              <span className="hint">
                {srcType || "?"} has no outbound slots — couple as:
              </span>
              {tgtSlots.map((s) => (
                <button key={s} onClick={() => commitCouple(target, s, couple.source)}>
                  {s === "parasite" ? "parasite" : `+ ${s}`} of {target}
                </button>
              ))}
            </>
          ) : (
            <span className="hint">
              neither type ({srcType || "?"} / {tgtType || "?"}) declares
              couplings
            </span>
          )}
          {(srcSlots.length === 0 || !srcType) && target && (
            <input
              placeholder="custom slot (advanced)"
              value={slotName}
              onChange={(e) => setSlotName(e.target.value)}
              spellCheck={false}
            />
          )}
          {(slotName.trim() && target && srcSlots.length > 0) ||
          (slotName.trim() && target && !srcType) ? (
            <button onClick={() => commitCouple(couple.source, slotName.trim(), target)}>
              + custom
            </button>
          ) : null}
          <button onClick={() => setCouple(null)}>cancel</button>
        </div>
      )}
    </div>
  );
}