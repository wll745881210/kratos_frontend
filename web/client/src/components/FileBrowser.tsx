import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { FsEntry } from "../model/types";

interface Props {
  initialDir: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Minimal directory browser modal backed by /api/fs/list. */
export function FileBrowser({ initialDir, onPick, onClose }: Props) {
  const [dir, setDir] = useState(initialDir);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState("");

  useEffect(() => {
    let dead = false;
    api
      .listDir(dir)
      .then((r) => {
        if (dead) return;
        setDir(r.dir); // server returns the canonical realpath
        setEntries(r.entries);
        setErr(null);
      })
      .catch((e) => !dead && setErr(String(e.message ?? e)));
    return () => {
      dead = true;
    };
  }, [dir]);

  const parent = dir.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            spellCheck={false}
          />
          <button onClick={() => setDir(parent)}>up</button>
          <button onClick={onClose}>close</button>
        </div>
        {err && <div className="issue error">{err}</div>}
        <div className="modal-list">
          {entries.map((e) => (
            <div
              key={e.name}
              className={"fs-" + e.type + (picked === e.name ? " picked" : "")}
              onClick={() =>
                e.type === "dir"
                  ? setDir(dir.replace(/\/+$/, "") + "/" + e.name)
                  : setPicked(e.name)
              }
              onDoubleClick={() =>
                e.type === "file" &&
                onPick(dir.replace(/\/+$/, "") + "/" + e.name)
              }
            >
              {e.type === "dir" ? "📁 " : "📄 "}
              {e.name}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button
            disabled={!picked}
            onClick={() => onPick(dir.replace(/\/+$/, "") + "/" + picked)}
          >
            open {picked}
          </button>
        </div>
      </div>
    </div>
  );
}
