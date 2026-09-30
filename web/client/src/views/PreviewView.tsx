/**
 * PreviewView — server-evaluated IC slice preview on Canvas2D.
 *
 * Debounced POST /api/preview/ic with the current Spec; renders one
 * primitive field as a false-colour image (nearest-neighbour upscaling,
 * v axis pointing up). No WebGL, no simulation run.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { IcPreview, Spec, Value } from "../model/types";

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

export function PreviewView({ spec }: Props) {
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
    const ctx = cv.getContext("2d");
    if (!f || !ctx) return;
    const nU = prev.u.n;
    const nV = prev.v.n;
    const img = ctx.createImageData(nU, nV);
    const d = img.data;
    const lo = f.min ?? 0;
    const hi = f.max ?? 1;
    const span = hi > lo ? hi - lo : 1;
    for (let j = 0; j < nV; j++) {
      const row = f.data[j];
      for (let i = 0; i < nU; i++) {
        const val = row[i];
        // canvas row 0 = top; data row 0 = v min -> flip
        const o = ((nV - 1 - j) * nU + i) * 4;
        if (!Number.isFinite(val)) {
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
  }, [prev, field]);

  if (!hasMesh) {
    return (
      <div className="previewpane">
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
