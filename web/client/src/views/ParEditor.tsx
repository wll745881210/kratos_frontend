import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { FileBrowser } from "../components/FileBrowser";
import { ProjectDialog } from "../components/ProjectDialog";
import { IssuesPanel } from "../components/IssuesPanel";
import { ModuleInspector } from "../components/ModuleInspector";
import { SectionCard } from "../components/SectionCard";
import { TextEditor } from "../components/TextEditor";
import {
  addCoupling,
  addModule,
  declaredRoles,
  isCouplingSection,
  isModuleSection,
  isRoleSection,
  removeCoupling,
  removeModule,
} from "../model/graph";
import type {
  Blocklib,
  Issue,
  SectionDescriptor,
  Spec,
  Value,
} from "../model/types";
import { DiagramView } from "./DiagramView";
import { PreviewView } from "./PreviewView";
import { GlobalsView } from "./GlobalsView";

type Tab = "globals" | "form" | "text" | "diagram" | "preview";

const NEW_TEMPLATE = `[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 64 64 1
n_cell_block = 64 64 1

[boundary]
kinds = fre fre fre fre fre fre

[dynamics]
gamma = 1.4

[cycle]
t_lim = 0.2
n_cycle_lim = 100000
dt_output = 0.1
t_output_next = 0.0
final_output = 1
prefix_output = out
`;

export function matchDesc(
  descs: SectionDescriptor[],
  section: string,
): SectionDescriptor | null {
  for (const d of descs) if (!d.wildcard && d.section === section) return d;
  for (const d of descs)
    if (d.wildcard && section.startsWith(d.section.slice(0, -1))) return d;
  return null;
}

export function ParEditor({
  descs,
  initialFile,
}: {
  descs: SectionDescriptor[];
  initialFile?: string | null;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [tab, setTab] = useState<Tab>("form");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [newSection, setNewSection] = useState("");
  const [blocklib, setBlocklib] = useState<Blocklib | null>(null);
  const [inspectRole, setInspectRole] = useState<string | null>(null);
  const saveAs = useRef<HTMLInputElement>(null);

  // ---- module block library (server-authoritative; static fallback) ----
  useEffect(() => {
    api.blocklib().then(setBlocklib).catch(() => {});
  }, []);

  // ---- debounced server validation -------------------------------------
  useEffect(() => {
    if (!spec) return;
    const h = setTimeout(() => {
      api.validateSpec(spec).then((r) => setIssues(r.issues)).catch(() => {});
    }, 400);
    return () => clearTimeout(h);
  }, [spec]);

  const openFile = useCallback(async (p: string) => {
    const f = await api.readFile(p);
    const r = await api.parsePar(f.text);
    setPath(f.path);
    setText(f.text);
    setSpec(r.spec);
    setIssues(r.issues);
    setDirty(false);
    setTab("form");
    setStatus(`opened ${f.path}`);
    setBrowsing(false);
  }, []);

  // ---- open a file outside the whitelisted roots: grant its dir, retry --
  const openWithGrant = useCallback(
    async (p: string) => {
      try {
        await openFile(p);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) {
          const dir = p.replace(/\/[^/]*$/, "") || "/";
          await api.setCwd(dir); // whitelist the file's directory
          await openFile(p);
        } else {
          setStatus(String(e instanceof Error ? e.message : e));
        }
      }
    },
    [openFile],
  );

  // ---- deep link: /?file=/abs/path.par (from `kratos-front open`) -------
  useEffect(() => {
    if (!initialFile) return;
    window.history.replaceState(null, "", window.location.pathname);
    void openWithGrant(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newFile = useCallback(async () => {
    const r = await api.parsePar(NEW_TEMPLATE);
    setPath(null);
    setText(NEW_TEMPLATE);
    setSpec(r.spec);
    setIssues(r.issues);
    setDirty(true);
    setTab("form");
    setStatus("new file (unsaved)");
  }, []);

  // ---- spec mutation helpers -------------------------------------------
  const mutate = (fn: (s: Spec) => Spec) => {
    setSpec((s) => (s ? fn(structuredClone(s)) : s));
    setDirty(true);
  };
  const setKey = (sec: string, key: string, v: Value) =>
    mutate((s) => ((s.sections[sec][key] = v), s));
  const removeKey = (sec: string, key: string) =>
    mutate((s) => (delete s.sections[sec][key], s));
  const removeSection = (sec: string) =>
    mutate((s) => (delete s.sections[sec], s));
  const addSection = (name: string) => {
    name = name.trim();
    if (!name || (spec && name in spec.sections)) return;
    mutate((s) => ((s.sections[name] = {}), s));
    setNewSection("");
  };

  // ---- tab switching keeps both sides consistent -----------------------
  const switchTab = async (next: Tab) => {
    if (next === tab || !spec) return;
    try {
      if (tab === "text" && next !== "text") {
        const r = await api.parsePar(text);
        setSpec(r.spec);
        setIssues(r.issues);
      } else if (next === "text") {
        const r = await api.emitPar(spec);
        if (r.text === null) {
          setStatus("cannot emit: fix validation errors first");
          setIssues(r.issues);
          return;
        }
        setText(r.text);
        setIssues(r.issues);
      }
      setTab(next);
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e));
    }
  };

  // ---- diagram callbacks ------------------------------------------------
  const diagramOps = useMemo(
    () => ({
      onAddModule: (role: string, type: string) => {
        let err: string | null = null;
        mutate((s) => {
          err = addModule(s, role, type);
          return s;
        });
        return err;
      },
      onRemoveModule: (role: string) => {
        setInspectRole((r) => (r === role ? null : r));
        mutate((s) => (removeModule(s, role), s));
      },
      onAddCoupling: (fromRole: string, key: string, toRole: string) =>
        mutate((s) => (addCoupling(s, fromRole, key, toRole), s)),
      onRemoveCoupling: (fromRole: string, key: string, toRole?: string) =>
        mutate((s) => (removeCoupling(s, fromRole, key, toRole), s)),
      onInspectRole: (role: string | null) => setInspectRole(role),
    }),
    [],
  );

  // ---- save -------------------------------------------------------------
  const save = async () => {
    if (!spec) return;
    let p = path ?? saveAs.current?.value.trim() ?? "";
    if (!p) {
      setStatus("no path: enter a save path in the header box");
      saveAs.current?.focus();
      return;
    }
    try {
      let out = text;
      if (tab !== "text") {
        const r = await api.emitPar(spec);
        if (r.text === null) {
          setIssues(r.issues);
          setStatus("cannot save: fix validation errors first");
          return;
        }
        out = r.text;
      } else {
        const r = await api.parsePar(text); // surface issues before writing
        setIssues(r.issues);
      }
      const w = await api.writeFile(p, out);
      setPath(w.path);
      setText(out);
      setDirty(false);
      setStatus(`saved ${w.path} (${w.bytes} bytes)`);
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e));
    }
  };

  // ---- ordering ---------------------------------------------------------
  // The Form tab shows native sections only: module/coupling/role-scoped
  // sections are edited in the Diagram inspector (their canonical home).
  const ordered = useMemo(() => {
    if (!spec) return [];
    const roles = declaredRoles(spec);
    const native = Object.keys(spec.sections).filter(
      (n) =>
        !isModuleSection(n) &&
        !isCouplingSection(n) &&
        !isRoleSection(n, roles),
    );
    const rank = (n: string) => matchDesc(descs, n)?.order ?? 10000;
    return native.sort((a, b) => rank(a) - rank(b));
  }, [spec, descs]);

  const suggestions = useMemo(() => {
    const taken = new Set(ordered);
    return descs
      .map((d) => (d.wildcard ? d.section.slice(0, -1) : d.section))
      .filter((n) => !taken.has(n));
  }, [descs, ordered]);

  return (
    <div className="editor">
      <div className="toolbar">
        <button onClick={() => setBrowsing(true)}>Open…</button>
        <button onClick={newFile}>New</button>
        <button onClick={save} disabled={!spec}>
          Save{dirty ? "*" : ""}
        </button>
        <button onClick={() => setShowProject(true)} disabled={!path}>
          Project…
        </button>
        <input
          ref={saveAs}
          className="path"
          placeholder={path ?? "save path (absolute)"}
          defaultValue={path ?? ""}
          key={path ?? "none"}
          spellCheck={false}
        />
        <div className="tabs">
          <button
            className={tab === "globals" ? "on" : ""}
            onClick={() => switchTab("globals")}
          >
            Globals
          </button>
          <button
            className={tab === "form" ? "on" : ""}
            onClick={() => switchTab("form")}
          >
            Form
          </button>
          <button
            className={tab === "text" ? "on" : ""}
            onClick={() => switchTab("text")}
          >
            Text
          </button>
          <button
            className={tab === "diagram" ? "on" : ""}
            onClick={() => switchTab("diagram")}
          >
            Diagram
          </button>
          <button
            className={tab === "preview" ? "on" : ""}
            onClick={() => switchTab("preview")}
          >
            Preview
          </button>
        </div>
        <span className="status">{status}</span>
      </div>

      {!spec && <div className="empty">Open a .par file or create a new one.</div>}

      {spec && tab === "globals" && (
        <GlobalsView spec={spec} mutate={mutate} issues={issues} />
      )}

      {spec && tab === "form" && (
        <div className="columns">
          <div className="nav">
            {ordered.map((n) => (
              <a key={n} href={`#sec-${n}`}>[{n}]</a>
            ))}
            <div className="add-section">
              <input
                list="sec-names"
                placeholder="+ section"
                value={newSection}
                onChange={(e) => setNewSection(e.target.value)}
                spellCheck={false}
              />
              <datalist id="sec-names">
                {suggestions.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <button disabled={!newSection.trim()} onClick={() => addSection(newSection)}>
                add
              </button>
            </div>
          </div>
          <div className="form">
            {ordered.map((n) => (
              <SectionCard
                key={n}
                name={n}
                desc={matchDesc(descs, n)}
                values={spec.sections[n]}
                issues={issues.filter((i) => i.where === n || i.where.startsWith(n + "."))}
                onSet={(k, v) => setKey(n, k, v)}
                onRemoveKey={(k) => removeKey(n, k)}
                onRemoveSection={() => removeSection(n)}
              />
            ))}
          </div>
          <div className="side">
            <IssuesPanel issues={issues} />
          </div>
        </div>
      )}

      {spec && tab === "text" && (
        <div className="columns">
          <div className="textpane">
            <TextEditor value={text} onChange={(t) => { setText(t); setDirty(true); }} />
          </div>
          <div className="side">
            <IssuesPanel issues={issues} />
          </div>
        </div>
      )}

      {spec && tab === "diagram" && (
        <div className="columns">
          <div className="diagrampane">
            <DiagramView
              key={path ?? "new"}
              spec={spec}
              ops={diagramOps}
              blocklib={blocklib}
              positions={(spec.meta?.diagram_positions as
                | Record<string, { x: number; y: number }>
                | undefined) ?? undefined}
              onPositions={(pos) => {
                mutate((s) => {
                  s.meta.diagram_positions = pos;
                  return s;
                });
              }}
            />
          </div>
          <div className="side">
            {inspectRole !== null && spec && (
              <ModuleInspector
                spec={spec}
                descs={descs}
                issues={issues}
                role={inspectRole}
                mutate={mutate}
                onClose={() => setInspectRole(null)}
              />
            )}
            <IssuesPanel issues={issues} />
          </div>
        </div>
      )}

      {spec && tab === "preview" && (
        <div className="columns">
          <div className="diagrampane">
            <PreviewView spec={spec} />
          </div>
          <div className="side">
            <IssuesPanel issues={issues} />
          </div>
        </div>
      )}

      {browsing && (
        <FileBrowser
          initialDir={path ? path.replace(/\/[^/]*$/, "") : "/"}
          onPick={openFile}
          onClose={() => setBrowsing(false)}
        />
      )}

      {showProject && path && (
        <ProjectDialog
          path={path}
          currentText={async () => {
            if (tab === "text") return text;
            const r = await api.emitPar(spec!);
            return r.text;
          }}
          onClose={() => setShowProject(false)}
        />
      )}
    </div>
  );
}
