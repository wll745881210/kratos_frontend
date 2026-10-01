/**
 * PreviewView — server-evaluated IC slice preview on Canvas2D.
 *
 * Debounced POST /api/preview/ic with the current Spec; renders one
 * primitive field as a false-colour image (nearest-neighbour upscaling,
 * v axis pointing up). No WebGL, no simulation run.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { BinPreview, BinSlice, IcPreview, Spec, Value } from "../model/types";

const AXIS_NAMES = ["x", "y", "z"];
const MAX_DIM = 384;

/** Simple blue→cyan→green→yellow→red colormap, t in [0,1]. */
function colormap(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [13, 8, 135]],
    [0.25, [33, 96, 226]],
    [0.5, [33, 196, 175]],
    [0.75, [180, 222, 44]],
    [1.0, [249, 251, 21]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function meshNCell(spec: Spec): number[] | null {
  const v = spec.sections["mesh"]?.["n_cell_global"];
  if (Array.isArray(v)) {
    const n = v.map((x) => Number(x));
    return n.length === 3 && n.every((x) => Number.isFinite(x)) ? n : null;
  }
  return null;
}

function vec3(v: Value | undefined): number[] | null {
  if (Array.isArray(v)) {
    const n = v.map((x) => Number(x));
    return n.every((x) => Number.isFinite(x)) ? n : null;
  }
  if (typeof v === "number") return [v, v, v];
  return null;
}

interface Props {
  spec: Spec;
}

/** Draw a (rows=v, cols=u) scalar image with v axis pointing up. */
function drawHeat(
  cv: HTMLCanvasElement,
  data: (number | null)[][],
  lo: number,
  hi: number,
) {
  const nV = data.length;
  const nU = data[0]?.length ?? 0;
  if (!nU || !nV) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(nU, nV);
  const d = img.data;
  const span = hi > lo ? hi - lo : 1;
  for (let j = 0; j < nV; j++) {
    const row = data[j];
    for (let i = 0; i < nU; i++) {
      const val = row[i];
      // canvas row 0 = top; data row 0 = v min -> flip
      const o = ((nV - 1 - j) * nU + i) * 4;
      if (val === null || !Number.isFinite(val)) {
        d[o] = 128;
        d[o + 1] = 128;
        d[o + 2] = 128;
      } else {
        const [r, g, b] = colormap((val - lo) / span);
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
      }
      d[o + 3] = 255;
    }
  }
  const off = document.createElement("canvas");
  off.width = nU;
  off.height = nV;
  off.getContext("2d")?.putImageData(img, 0, 0);
  const W = 560;
  const H = Math.max(64, Math.round((W * nV) / nU));
  cv.width = W;
  cv.height = H;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, W, H);
}

/** BinPreviewPanel — exact AMR block list + field slice from a .bin. */
function BinPreviewPanel() {
  const [path, setPath] = useState("");
  const [info, setInfo] = useState<BinPreview | null>(null);
  const [block, setBlock] = useState("");
  const [field, setField] = useState("");
  const [component, setComponent] = useState(0);
  const [axis, setAxis] = useState(2);
  const [index, setIndex] = useState(0);
  const [slice, setSlice] = useState<BinSlice | null>(null);
  const [status, setStatus] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);

  const load = async () => {
    setStatus("loading…");
    try {
      const r = await api.previewBin(path);
      setInfo(r);
      const b = r.blocks[0]?.name ?? "";
      setBlock(b);
      const f0 = (r.fields[b] ?? [])[0] ?? "";
      setField(f0);
      setComponent(0);
      setStatus(
        `t=${r.globals.time ?? "?"} cycle=${r.globals.cycle ?? "?"} · ` +
          `${r.blocks.length} block(s)`,
      );
    } catch (e) {
      setInfo(null);
      setStatus(e instanceof ApiError ? `load failed: ${e.message}` : String(e));
    }
  };

  /* Debounced slice fetch. */
  useEffect(() => {
    if (!info || !block || !field) return;
    const my = ++seq.current;
    const h = window.setTimeout(() => {
      api
        .previewBin(path, field, { block, component, axis, index })
        .then((r) => {
          if (seq.current !== my) return;
          setSlice(r.slice ?? null);
        })
        .catch((e) => {
          if (seq.current !== my) return;
          setStatus(e instanceof ApiError ? e.message : String(e));
        });
    }, 300);
    return () => window.clearTimeout(h);
  }, [info, path, block, field, component, axis, index]);

  /* Canvas render. */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !slice) return;
    drawHeat(cv, slice.data, slice.min ?? 0, slice.max ?? 1);
  }, [slice]);

  const fields = info && block ? (info.fields[block] ?? []) : [];
  const nIdx = slice?.n_index ?? 1;

  return (
    <div className="previewpane">
      <div className="preview-controls">
        <input
          className="path"
          placeholder="absolute path to a kratos .bin output"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => e.key === "Enter" && load()}
        />
        <button onClick={load} disabled={!path.trim()}>
          Load
        </button>
      </div>
      {info && (
        <div className="preview-controls">
          {info.blocks.length > 1 && (
            <label>
              block{" "}
              <select value={block} onChange={(e) => setBlock(e.target.value)}>
                {info.blocks.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name} (L{b.level})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            field{" "}
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label>
            comp{" "}
            <input
              type="number"
              min={0}
              value={component}
              onChange={(e) => setComponent(Number(e.target.value))}
              style={{ width: "4em" }}
            />
          </label>
          <label>
            normal{" "}
            <select
              value={axis}
              onChange={(e) => {
                setAxis(Number(e.target.value));
                setIndex(0);
              }}
            >
              {AXIS_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            slice{" "}
            <input
              type="range"
              min={0}
              max={Math.max(0, nIdx - 1)}
              value={Math.min(index, nIdx - 1)}
              onChange={(e) => setIndex(Number(e.target.value))}
            />
            {slice && (
              <span className="mono">
                {" "}
                {AXIS_NAMES[axis]}[{slice.index}/{nIdx}]
              </span>
            )}
          </label>
        </div>
      )}
      {info && <canvas ref={canvasRef} className="preview-canvas" />}
      {slice && (
        <div className="preview-readout mono">
          {slice.field}[{slice.component}] ∈ [
          {slice.min === null ? "n/a" : slice.min.toPrecision(4)},{" "}
          {slice.max === null ? "n/a" : slice.max.toPrecision(4)}] · plane ∈ [
          {slice.extent.map((v) => v.toPrecision(4)).join(", ")}]
        </div>
      )}
      {info && (
        <ul className="preview-issues">
          {info.blocks.map((b) => (
            <li key={b.name} className="info">
              {b.name}: L{b.level} n_cell=[{b.n_cell.join(",")}] xf0=[
              {b.xf0.map((v) => v.toPrecision(4)).join(",")}] dx0=[
              {b.dx0.map((v) => v.toPrecision(4)).join(",")}]
            </li>
          ))}
        </ul>
      )}
      {status && <p className="hint">{status}</p>}
    </div>
  );
}

export function PreviewView({ spec }: Props) {
  const [mode, setMode] = useState<"ic" | "bin">("ic");
  const [axis, setAxis] = useState(2);
  const [index, setIndex] = useState(0);
  const [field, setField] = useState<string>("rho");
  const [prev, setPrev] = useState<IcPreview | null>(null);
  const [status, setStatus] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);

  const nCell = useMemo(() => meshNCell(spec), [spec]);
  const hasMesh = nCell !== null && vec3(spec.sections["mesh"]?.["x_min"]) !== null;

  /* Debounced evaluation. */
  useEffect(() => {
    if (!hasMesh) return;
    const my = ++seq.current;
    const h = window.setTimeout(() => {
      api
        .previewIc(spec, axis, index, MAX_DIM)
        .then((p) => {
          if (seq.current !== my) return;
          setPrev(p);
          const names = Object.keys(p.fields);
          if (names.length && !names.includes(field)) setField(names[0]);
          setStatus(
            p.issues.some((i) => i.level === "error")
              ? "evaluated with errors"
              : "",
          );
        })
        .catch((e) => {
          if (seq.current !== my) return;
          setStatus(e instanceof ApiError ? `preview failed: ${e.message}` : String(e));
        });
    }, 400);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, axis, index, hasMesh]);

  /* Canvas render. */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !prev) return;
    const f = prev.fields[field];
    if (!f) return;
    drawHeat(cv, f.data, f.min ?? 0, f.max ?? 1);
  }, [prev, field]);

  if (mode === "bin") {
    return (
      <div className="previewpane">
        <div className="preview-controls">
          <div className="tabs">
            <button onClick={() => setMode("ic")}>IC (spec)</button>
            <button className="on" onClick={() => setMode("bin")}>
              BIN (output)
            </button>
          </div>
        </div>
        <BinPreviewPanel />
      </div>
    );
  }

  if (!hasMesh) {
    return (
      <div className="previewpane">
        <div className="preview-controls">
          <div className="tabs">
            <button className="on" onClick={() => setMode("ic")}>
              IC (spec)
            </button>
            <button onClick={() => setMode("bin")}>BIN (output)</button>
          </div>
        </div>
        <p className="hint">
          Preview needs [mesh] x_min / x_max / n_cell_global in the spec.
        </p>
      </div>
    );
  }

  const f = prev?.fields[field];
  const normalN = nCell ? nCell[axis] : 1;

  return (
    <div className="previewpane">
      <div className="preview-controls">
        <div className="tabs">
          <button className="on" onClick={() => setMode("ic")}>
            IC (spec)
          </button>
          <button onClick={() => setMode("bin")}>BIN (output)</button>
        </div>
        <label>
          field{" "}
          <select value={field} onChange={(e) => setField(e.target.value)}>
            {Object.keys(prev?.fields ?? { rho: 1 }).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          normal{" "}
          <select
            value={axis}
            onChange={(e) => {
              setAxis(Number(e.target.value));
              setIndex(0);
            }}
          >
            {AXIS_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          slice{" "}
          <input
            type="range"
            min={0}
            max={Math.max(0, normalN - 1)}
            value={Math.min(index, normalN - 1)}
            onChange={(e) => setIndex(Number(e.target.value))}
          />
          {prev && (
            <span className="mono">
              {" "}
              {AXIS_NAMES[axis]}={prev.coord.toPrecision(4)} ({prev.index}/
              {normalN})
            </span>
          )}
        </label>
      </div>
      <canvas ref={canvasRef} className="preview-canvas" />
      {prev && f && (
        <div className="preview-readout mono">
          {prev.u.name} ∈ [{prev.u.min}, {prev.u.max}] · {prev.v.name} ∈ [
          {prev.v.min}, {prev.v.max}] · {field} ∈ [
          {f.min === null ? "n/a" : f.min.toPrecision(4)},{" "}
          {f.max === null ? "n/a" : f.max.toPrecision(4)}]
        </div>
      )}
      {prev && prev.issues.length > 0 && (
        <ul className="preview-issues">
          {prev.issues.map((i, k) => (
            <li key={k} className={i.level}>
              [{i.where}] {i.message}
            </li>
          ))}
        </ul>
      )}
      {status && <p className="hint">{status}</p>}
    </div>
  );
}
