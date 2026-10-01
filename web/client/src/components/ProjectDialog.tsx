/**
 * ProjectDialog — project/bundle operations for the current editor state.
 *
 * Actions: init project from the current spec, save spec into an existing
 * project manifest (+ regenerate par snapshot), check a project, export a
 * bundle, import a bundle with an optional JSON-Merge-Patch scale override
 * (whitelist-enforced server-side).
 */

import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { Issue } from "../model/types";

interface Props {
  /** Current par path (used to prefill the project dir). */
  path: string | null;
  /** Emit current editor state as par text (for init/save). */
  currentText: () => Promise<string | null>;
  onClose: () => void;
}

type Action = "init" | "save" | "check" | "export" | "import";

export function ProjectDialog({ path, currentText, onClose }: Props) {
  const parDir = path ? path.replace(/\/[^/]*$/, "") : "";
  const [action, setAction] = useState<Action>("init");
  const [dir, setDir] = useState(parDir);
  const [bundlePath, setBundlePath] = useState("");
  const [override, setOverride] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const say = (s: string) => setLog((l) => [...l, s]);
  const fmtIssues = (iss: Issue[]) =>
    iss.forEach((i) => say(`${i.level}: [${i.where}] ${i.message}`));

  const run = async () => {
    setBusy(true);
    try {
      if (action === "init") {
        const text = await currentText();
        const r = await api.projectInit(dir, text ?? undefined);
        say(`project created: ${r.dir}/kratos.project.json`);
      } else if (action === "save") {
        const { manifest } = await api.projectLoad(dir);
        const text = await currentText();
        if (text === null) {
          say("current spec has errors; not saved");
          return;
        }
        const parsed = await api.parsePar(text);
        (manifest as { spec: unknown }).spec = parsed.spec;
        await api.projectSave(dir, manifest);
        say(`spec saved into project ${dir}`);
        const chk = await api.projectCheck(dir);
        fmtIssues(chk.issues);
        if (!chk.issues.length) say("project check: OK");
      } else if (action === "check") {
        const chk = await api.projectCheck(dir);
        fmtIssues(chk.issues);
        if (!chk.issues.length) say("project check: OK");
      } else if (action === "export") {
        const r = await api.bundleExport(dir);
        say(`bundle: ${r.bundle}`);
      } else if (action === "import") {
        let patch: unknown;
        if (override.trim()) {
          try {
            patch = JSON.parse(override);
          } catch {
            say("override is not valid JSON");
            return;
          }
        }
        const r = await api.bundleImport(bundlePath, dir, patch);
        fmtIssues(r.issues);
        say(`imported to ${r.dir}`);
      }
    } catch (e) {
      say(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ACTIONS: { id: Action; label: string }[] = [
    { id: "init", label: "Init project" },
    { id: "save", label: "Save to project" },
    { id: "check", label: "Check project" },
    { id: "export", label: "Export bundle" },
    { id: "import", label: "Import bundle" },
  ];

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal projectdialog" onClick={(e) => e.stopPropagation()}>
        <div className="project-actions">
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              className={action === a.id ? "on" : ""}
              onClick={() => {
                setAction(a.id);
                setLog([]);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        {action === "import" && (
          <label className="row">
            bundle
            <input
              value={bundlePath}
              onChange={(e) => setBundlePath(e.target.value)}
              placeholder="/abs/path/p.kratos-bundle.tar.gz"
              spellCheck={false}
            />
          </label>
        )}
        <label className="row">
          {action === "import" ? "dest dir" : "project dir"}
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            spellCheck={false}
          />
        </label>
        {action === "import" && (
          <label className="row col">
            scale override (JSON Merge Patch, whitelist-enforced)
            <textarea
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder='{"mesh": {"n_cell_global": [1024, 1024, 1024]}}'
              rows={3}
              spellCheck={false}
            />
          </label>
        )}
        <div className="row buttons">
          <button onClick={run} disabled={busy || !dir}>
            Run
          </button>
          <button onClick={onClose}>Close</button>
        </div>
        {log.length > 0 && (
          <pre className="project-log">
            {log.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
