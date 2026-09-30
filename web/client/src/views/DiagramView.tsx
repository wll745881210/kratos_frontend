// Block-diagram view of a Spec: core sections as fixed nodes, one node per
// [module.<role>], edges from [coupling.<role>] (parasite = dashed, named
// slots = solid). Purely derived from the Spec; all edits go back through
// the mutation callbacks (the Spec stays the single source of truth).

import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  CORE_SECTIONS,
  type Graph,
  MODULE_TYPES,
  moduleNodeId,
  specToGraph,
} from "../model/graph";

export interface DiagramOps {
  onAddModule: (role: string, type: string) => void;
  onRemoveModule: (role: string) => void;
  onAddCoupling: (fromRole: string, key: string, toRole: string) => void;
  onRemoveCoupling: (fromRole: string, key: string, toRole?: string) => void;
  onJumpToSection: (section: string) => void;
}

interface NodeData {
  label: string;
  sub?: string;
  missing?: boolean;
  core?: boolean;
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
      {!data.core && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const nodeTypes = { kratos: KratosNode };

// Columnar auto-layout: core sections left, modules right (by order, then
// role). Dragging is free-form but not persisted (project files: M2.4).
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

export function DiagramView({
  spec,
  ops,
}: {
  spec: Parameters<typeof specToGraph>[0];
  ops: DiagramOps;
}) {
  const graph = useMemo(() => specToGraph(spec), [spec]);
  const { nodes, edges } = useMemo(() => layout(graph), [graph]);
  const [pending, setPending] = useState<Connection | null>(null);
  const [slotName, setSlotName] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newType, setNewType] = useState<string>(MODULE_TYPES[0]);

  const onConnect = useCallback((c: Connection) => setPending(c), []);

  const commitPending = (key: string) => {
    if (!pending?.source || !pending.target || !key.trim()) return;
    ops.onAddCoupling(
      pending.source.replace(/^module:/, ""),
      key.trim(),
      pending.target.replace(/^module:/, ""),
    );
    setPending(null);
    setSlotName("");
  };

  return (
    <div className="diagram-wrap">
      <div className="diagram-toolbar">
        <input
          placeholder="new module role"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          spellCheck={false}
        />
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        >
          {MODULE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          disabled={!newRole.trim() || graph.nodes.some(
            (n) => n.kind === "module" && n.role === newRole.trim(),
          )}
          onClick={() => {
            ops.onAddModule(newRole.trim(), newType);
            setNewRole("");
          }}
        >
          + module
        </button>
        <span className="hint">
          drag from a node's right handle to another node to couple · select +
          Delete to remove · double-click a node to edit its section
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
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
          if (g && !g.missing) ops.onJumpToSection(g.section);
        }}
        deleteKeyCode={["Delete", "Backspace"]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} />
        <Controls />
      </ReactFlow>

      {pending && (
        <div className="coupling-dialog">
          <div>
            couple <b>{pending.source?.replace(/^module:/, "")}</b> →{" "}
            <b>{pending.target?.replace(/^module:/, "")}</b>
          </div>
          <button onClick={() => commitPending("parasite")}>parasite</button>
          <input
            placeholder="slot name"
            value={slotName}
            onChange={(e) => setSlotName(e.target.value)}
            spellCheck={false}
          />
          <button
            disabled={!slotName.trim()}
            onClick={() => commitPending(slotName)}
          >
            + slot
          </button>
          <button onClick={() => setPending(null)}>cancel</button>
        </div>
      )}
    </div>
  );
}
