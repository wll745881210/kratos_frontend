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
  couplingSection,
  type EdgeEnds,
  type Graph,
  MODULE_LABELS,
  MODULE_TYPES,
  moduleNodeId,
  moduleRoleProblem,
  moduleType,
  parasiteHostCandidates,
  SLOT_TARGET_TYPES,
  slotTargetProblem,
  specToGraph,
} from "../model/graph";
import type { Blocklib, Spec } from "../model/types";

export interface DiagramOps {
  /** returns an error message when the module was NOT added, else null */
  onAddModule: (role: string, type: string) => string | null;
  onRemoveModule: (role: string) => void;
  onAddCoupling: (
    fromRole: string,
    key: string,
    toRole: string,
    ends?: EdgeEnds,
  ) => void;
  onRemoveCoupling: (fromRole: string, key: string, toRole?: string) => void;
  /** sequence `role` after `afterRole` (order values; any two modules
   * on the shared mesh can be ordered) and keep the drawn edge */
  onOrderAfter: (role: string, afterRole: string) => void;
  /** forget a drawn execution-order edge (par truth stays) */
  onRemoveOrderEdge: (fromRole: string, toRole: string) => void;
  /** wire a chemistry module into the execution chain: parasite onto
   * the host AND run after `afterRole` (reads its processed output) */
  onChainModule: (
    chemRole: string,
    hostRole: string,
    afterRole: string,
  ) => void;
  /** open the in-diagram inspector for a module role */
  onInspectRole: (role: string | null) => void;
  /** open the in-diagram inspector for a global section (mesh/unit/…) */
  onInspectCore: (section: string | null) => void;
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
        <>
          {/* left/right handles: execution-order flow (provider right
              -> consumer left); top/bottom: parasite attachments.
              Each VERTICAL position carries BOTH a source and a
              target handle (overlapping) so ANY vertical drag
              between two modules completes — the dialog, not the
              handle geometry, decides which node is the parasite
              declarer. */}
          <Handle type="target" position={Position.Left} id="in" />
          <Handle type="target" position={Position.Top} id="top-in" />
          <Handle type="source" position={Position.Top} id="top-out" />
        </>
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
        <>
          <Handle type="source" position={Position.Right} id="out" />
          <Handle type="target" position={Position.Bottom} id="bot-in" />
          <Handle type="source" position={Position.Bottom} id="bot-out" />
        </>
      )}
    </div>
  );
}

const nodeTypes = { kratos: KratosNode };

// Edge rendering, split by relation kind so the geometry carries the
// semantics the user expects:
//   - slot couplings (dyn, sources, ...) = EXECUTION-ORDER FLOW: solid
//     edges on the SIDE handles, provider's right -> declarer's left.
//   - parasite bindings = a different relation entirely: dashed edges
//     on the VERTICAL handles, host's bottom -> parasite's top.
// GEdge.fromRole/toRole keep the declarer/provider roles for
// mutations; only the rendering is redirected.
export function flowEdges(g: Graph): Edge[] {
  return g.edges.map((e) =>
    e.parasite
      ? {
          id: e.id,
          source: e.toId, // host
          // attachment points: the user's drag choice (GEdge.srcEnd /
          // tgtEnd, persisted in spec.meta.edge_ends); auto-generated
          // edges default to bottom-to-bottom to avoid crossings
          sourceHandle: `${e.srcEnd ?? "bot"}-out`,
          target: e.fromId, // parasite (slot declarer)
          targetHandle: `${e.tgtEnd ?? "bot"}-in`,
          label: "parasite",
          animated: true,
          className: "gedge parasite",
        }
      : {
          id: e.id,
          source: e.toId, // provider (upstream)
          sourceHandle: "out",
          target: e.fromId, // slot declarer (downstream)
          targetHandle: "in",
          label: e.key === "chain" ? "output" : e.key === "ord" ? "after" : e.key,
          animated: false,
          className: "gedge",
        },
  );
}

// Columnar auto-layout: core sections left, modules right (by order, then
// role). Dragging is free-form and persisted to spec.meta (M2.4).
function layout(g: Graph): { nodes: Node<NodeData>[]; edges: Edge[] } {
  // Global-parameter boxes are ALWAYS drawn (dashed, left column) —
  // [unit] shows even in code-unit pars so the affordance is uniform;
  // absent sections get an "unset" sub-label. mesh/boundary/cycle exist
  // in every runnable par; unit/device are optional.
  const present = new Set(
    g.nodes.filter((n) => n.kind === "core").map((n) => n.role),
  );
  const cores = CORE_SECTIONS;
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
      position: { x: 0, y: i * 70 },
      deletable: false,
      data: {
        label: `[${c}]`,
        core: true,
        sub: present.has(c) ? undefined : "unset",
      },
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
  return { nodes, edges: flowEdges(g) };
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
                  setCouple({ source: n.data.role ?? "", mode: "any" });
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
  // fixed; otherwise the user picks it (link button). `mode` records the
  // relation kind implied by how the dialog was opened: flow drags (side
  // handles) never offer the parasite slot, vertical drags (top/bottom
  // handles) only offer it; the link button offers everything.
  const [couple, setCouple] = useState<
    | {
        source: string;
        target?: string;
        mode: "flow" | "parasite" | "any";
        /** vertical attachment points drawn by the user (drags only) */
        ends?: EdgeEnds;
      }
    | null
  >(null);
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

  // The dialog's "peer": fixed after a handle drag, picked (select)
  // otherwise.  Rendered at the appropriate side of the flow arrow.
  const peerPick = !couple ? null : couple.target !== undefined ? (
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
  );

  // Side-handle drags are EXECUTION-ORDER FLOW: the drag ends at the
  // DOWNSTREAM node's target (left) handle, that node is the coupling
  // declarer, the drag source the provider (both directions agree).
  // Vertical-handle drags are PARASITE attachments: every vertical
  // position carries overlapping source+target handles, so ANY vertical
  // drag completes; the declarer is whichever side is a chemistry-type
  // module (the only parasite declarer the container supports), not the
  // drag geometry.
  const isVerticalHandle = (h?: string | null) =>
    !!h && (h.startsWith("top") || h.startsWith("bot"));
  const posOf = (h?: string | null): "top" | "bot" =>
    h?.startsWith("top") ? "top" : "bot";
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      setSlotName("");
      setLinkTarget("");
      const a = stripModule(c.target);
      const b = stripModule(c.source);
      if (isVerticalHandle(c.sourceHandle) || isVerticalHandle(c.targetHandle)) {
        const aType = moduleType(spec, a);
        const bType = moduleType(spec, b);
        const decl = aType === "chemistry" ? a : bType === "chemistry" ? b : a;
        const host = decl === a ? b : a;
        // honor the exact vertical points the user dragged: the
        // rendered edge attaches at these positions (host = source
        // side, declarer = target side)
        const ends = {
          src: host === b ? posOf(c.sourceHandle) : posOf(c.targetHandle),
          tgt: decl === b ? posOf(c.sourceHandle) : posOf(c.targetHandle),
        };
        setCouple({ source: decl, target: host, mode: "parasite", ends });
      } else {
        setCouple({ source: a, target: b, mode: "flow" });
      }
    },
    [spec],
  );

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

  const commitCouple = (
    fromRole: string,
    key: string,
    toRole: string,
    ends?: EdgeEnds,
  ) => {
    ops.onAddCoupling(fromRole, key, toRole, ends);
    setCouple(null);
    setSlotName("");
    setLinkTarget("");
  };
  const commitOrder = (role: string, afterRole: string) => {
    ops.onOrderAfter(role, afterRole);
    setCouple(null);
    setSlotName("");
    setLinkTarget("");
  };
  const commitChain = (chem: string, host: string, after: string) => {
    ops.onChainModule(chem, host, after);
    setCouple(null);
    setSlotName("");
    setLinkTarget("");
  };

  // Semantic coupling choices: slots offered by the SOURCE module's type
  // (from the block library, mirroring the C++ container).  When the
  // source has no outbound slots the direction is reversed automatically.
  // Flow drags never offer the "parasite" slot (that relation attaches on
  // the vertical handles); parasite drags only offer it.
  const mode = couple?.mode ?? "any";
  const srcType = couple ? moduleType(spec, couple.source) : "";
  const tgtType = couple ? moduleType(spec, target) : "";
  const filterSlots = (ss: string[]) =>
    mode === "flow"
      ? ss.filter((s) => s !== "parasite")
      : mode === "parasite"
        ? ss.filter((s) => s === "parasite")
        : ss;
  const srcSlots = couple ? filterSlots(slotsOf(srcType)) : [];
  const tgtSlots = couple ? filterSlots(slotsOf(tgtType)) : [];
  // C++-mirrored target-type gates (slot_targets): a blocked combo
  // would hard-throw in the container / at module init. Prefer the
  // server's table; the local constant is the fallback.
  const slotTargets = blocklib?.slot_targets ?? SLOT_TARGET_TYPES;
  const srcBlocked = srcSlots
    .map((s) => slotTargetProblem(srcType, s, tgtType, slotTargets))
    .find((p) => p !== null) as string | null | undefined;
  const tgtBlocked = tgtSlots
    .map((s) => slotTargetProblem(tgtType, s, srcType, slotTargets))
    .find((p) => p !== null) as string | null | undefined;
  const blockReason = (srcBlocked ?? tgtBlocked) || null;
  const parasiteFiltered =
    mode === "flow" &&
    (slotsOf(srcType).includes("parasite") ||
      slotsOf(tgtType).includes("parasite"));
  // A dragged pair containing a chemistry module but no viable direct
  // slot (e.g. horizontal post -> chemistry) still has a legal wiring:
  // chemistry parasitizes a multi-species host — discovered through
  // the peer's own couplings (the module feeding it) — and takes its
  // place in the chain via the module's `order`.
  const chemRole = couple
    ? srcType === "chemistry"
      ? couple.source
      : tgtType === "chemistry"
        ? target
        : null
    : null;
  const directOk =
    srcSlots.some(
      (s) => !slotTargetProblem(srcType, s, tgtType, slotTargets),
    ) ||
    tgtSlots.some((s) => !slotTargetProblem(tgtType, s, srcType, slotTargets));
  const hosts =
    chemRole != null && !directOk
      ? parasiteHostCandidates(
          spec,
          chemRole,
          chemRole === couple?.source ? target : (couple?.source ?? ""),
        )
      : [];
  const curHost =
    chemRole != null
      ? String(spec.sections[couplingSection(chemRole)]?.parasite ?? "")
      : "";
  // the module whose processed output chemistry will read: the peer
  // the user dragged from/to (post in the post -> chemistry drag)
  const afterRole =
    chemRole != null && couple
      ? chemRole === couple.source
        ? target
        : couple.source
      : "";

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
            : "edit opens inspector · link offers couplings · drag handles: left/right = flow, top/bottom = parasite (chemistry ⇢ chem_hydro/chem_mhd) · double-click any node (incl. global boxes) to inspect"}
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edgesSel}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        connectionRadius={34}
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
            // synthesized execution-chain edges are derived (parasite
            // binding + orders), not stored couplings — not deletable
            if (e.id.startsWith("chain:")) return;
            const ge = graph.edges.find((g) => g.id === e.id);
            if (!ge) return;
            if (ge.key === "ord") {
              ops.onRemoveOrderEdge(ge.fromRole, ge.toRole);
              return;
            }
            ops.onRemoveCoupling(ge.fromRole, ge.key, ge.toRole);
          })
        }
        onNodeDoubleClick={(_, n) => {
          const g = graph.nodes.find((x) => x.id === n.id);
          if (g?.missing) return;
          if (g) {
            if (g.kind === "module") ops.onInspectRole(g.role);
            else ops.onInspectCore(g.section);
          } else if (n.id.startsWith("core:")) {
            // an "unset" global box (section absent from the spec)
            ops.onInspectCore(n.id.slice("core:".length));
          }
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
            {mode === "parasite" ? (
              // parasite: host holds the data, declarer attaches to it
              <>
                attach (parasite) {peerPick} ⇢{" "}
                <b>{couple.source || "module"}</b>
              </>
            ) : srcSlots.length ? (
              // data flow: provider -> declarer
              <>
                couple {peerPick} → <b>{couple.source || "module"}</b>
              </>
            ) : (
              // declarer has no slots: peer declares, data flows this way
              <>
                couple <b>{couple.source || "module"}</b> → {peerPick}
              </>
            )}
          </div>
          {srcSlots.length > 0 ? (
            srcSlots.map((s) => {
              const p = slotTargetProblem(srcType, s, tgtType, slotTargets);
              return (
                <button
                  key={s}
                  disabled={!target || !!p}
                  title={
                    p ??
                    `[${couplingSection(couple.source)}] ${s} = ${target || "?"}`
                  }
                  onClick={() =>
                    commitCouple(couple.source, s, target, couple.ends)
                  }
                >
                  + {couple.source || "module"}.{s}
                </button>
              );
            })
          ) : tgtSlots.length > 0 && target ? (
            <>
              <span className="hint">
                {srcType || "?"} has no outbound slots — couple as:
              </span>
              {tgtSlots.map((s) => {
                const p = slotTargetProblem(tgtType, s, srcType, slotTargets);
                return (
                  <button
                    key={s}
                    disabled={!!p}
                    title={
                      p ??
                      `[${couplingSection(target)}] ${s} = ${couple.source || "?"}`
                    }
                    onClick={() => commitCouple(target, s, couple.source)}
                  >
                    + {target}.{s}
                  </button>
                );
              })}
            </>
          ) : (
            <span className="hint">
              {parasiteFiltered
                ? "parasite-type couplings attach on the VERTICAL (top/bottom) handles — chemistry binds to its host (chem_hydro/chem_mhd) there"
                : `no coupling slots between ${srcType || "?"} and ${tgtType || "?"} — sequence them by execution order instead`}
            </span>
          )}
          {mode !== "parasite" && target && target !== couple.source && (
            <button
              title={`execution ordering (modules share the proxy field state):\n[module.${couple.source}] order > [module.${target}] order`}
              onClick={() => commitOrder(couple.source, target)}
            >
              + {couple.source || "module"} after {target}
            </button>
          )}
          {chemRole != null && !directOk && (
            <>
              <span className="hint">
                chemistry reads the full field state at its order — it
                runs AFTER {afterRole || "its processors"} and receives
                their output. Wire it: parasite onto the host feeding{" "}
                {afterRole || "?"}, order past it:
              </span>
              {hosts.length > 0 ? (
                hosts.map((h) => (
                  <button
                    key={h}
                    title={`[coupling.${chemRole}] parasite = ${h}\n[module.${chemRole}] order > ${afterRole}'s order`}
                    onClick={() => {
                      if (chemRole)
                        commitChain(chemRole, h, afterRole || h);
                    }}
                  >
                    + {chemRole} after {afterRole || "?"} (host {h})
                    {h === curHost ? " (current)" : ""}
                  </button>
                ))
              ) : (
                <span className="hint">
                  no chem_hydro/chem_mhd module in this project — add one
                  first, then attach chemistry (vertical handles)
                </span>
              )}
            </>
          )}
          {blockReason && (
            <div className="hint role-error">{blockReason}</div>
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
            <button
              disabled={
                slotName.trim() === "parasite" && mode !== "any"
                  ? true
                  : !!slotTargetProblem(
                      srcType,
                      slotName.trim(),
                      tgtType,
                      slotTargets,
                    )
              }
              onClick={() =>
                commitCouple(couple.source, slotName.trim(), target)
              }
            >
              + custom
            </button>
          ) : null}
          <button onClick={() => setCouple(null)}>cancel</button>
        </div>
      )}
    </div>
  );
}