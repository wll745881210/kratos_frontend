/** GlobalsView — curated editors for the core super-parameter sections:
 * [unit] (with live float32 overflow pre-check), [mesh] (geometry +
 * block layout), [cycle] (time integration + output cadence), [device].
 *
 * The Python xchecks module is the authoritative validator (it mirrors
 * the trunk throws); the inline hints here are for immediate feedback
 * and intentionally duplicate only the float32 range arithmetic.
 */
import { useEffect, useState } from "react";
import type { Issue, Spec, Value } from "../model/types";

const F32_MAX = 3.4028234663852886e38;
const F32_MIN_NORMAL = 1.1754943508222875e-38;
const CGS_MP = 1.67262192369e-24;

type Mutate = (fn: (s: Spec) => Spec) => void;

/* ------------------------------------------------------------------ */
/* Small controlled inputs                                             */
/* ------------------------------------------------------------------ */

function DraftInput(props: {
  value: string;
  onCommit: (text: string) => void;
  width?: number;
  placeholder?: string;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <input
      style={props.width ? { width: `${props.width}ch` } : undefined}
      value={text}
      placeholder={props.placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== props.value && props.onCommit(text)}
      onKeyDown={(e) => e.key === "Enter" && props.onCommit(text)}
    />
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <label style={{ minWidth: "14ch" }}>{props.label}</label>
      {props.children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getNum(spec: Spec, sec: string, key: string): number | null {
  const v = spec.sections[sec]?.[key];
  return typeof v === "number" ? v : null;
}

function getVec(spec: Spec, sec: string, key: string): number[] | null {
  const v = spec.sections[sec]?.[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "number"))
    return v as number[];
  return typeof v === "number" ? [v] : null;
}

function setKey(mutate: Mutate, sec: string, key: string, v: Value) {
  mutate((s) => {
    (s.sections[sec] ??= {})[key] = v;
    return s;
  });
}

function parseNum(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Commit helper: invalid text removes the key is too aggressive; keep
 * the old value and let server-side validation flag it instead — but a
 * non-numeric draft must not silently write a string into a numeric
 * slot, so we only commit parseable numbers. */
function NumField(props: {
  spec: Spec; sec: string; k: string; label: string; mutate: Mutate;
  placeholder?: string;
}) {
  const v = getNum(props.spec, props.sec, props.k);
  return (
    <Row label={props.label}>
      <DraftInput
        value={v === null ? "" : String(v)}
        placeholder={props.placeholder ?? "1"}
        onCommit={(t) => {
          const n = parseNum(t);
          if (n !== null) setKey(props.mutate, props.sec, props.k, n);
        }}
      />
    </Row>
  );
}

function Vec3Field(props: {
  spec: Spec; sec: string; k: string; label: string; mutate: Mutate;
}) {
  const v = getVec(props.spec, props.sec, props.k) ?? [null, null, null];
  const cur: (number | null)[] =
    v.length === 3 ? (v as number[]) : [null, null, null];
  return (
    <Row label={props.label}>
      {[0, 1, 2].map((a) => (
        <DraftInput
          key={a}
          width={10}
          value={cur[a] === null ? "" : String(cur[a])}
          onCommit={(t) => {
            const n = parseNum(t);
            if (n === null) return;
            const next = cur.map((x) => x ?? 0);
            next[a] = n;
            setKey(props.mutate, props.sec, props.k, next);
          }}
        />
      ))}
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* [unit]                                                              */
/* ------------------------------------------------------------------ */

type UnitMode = "density" | "mass";

function unitMode(spec: Spec): UnitMode {
  const u = spec.sections["unit"] ?? {};
  if (u["mass"] !== undefined) return "mass";
  return "density";
}

/** Mirrors kratos_spec.xchecks.unit_summary (client-side, instant). */
function unitSummary(spec: Spec) {
  const u = spec.sections["unit"] ?? {};
  const num = (k: string, d: number): number | null => {
    const v = u[k];
    if (v === undefined) return d;
    if (typeof v === "number") return v;
    if (v === "mp" || v === "mh") return CGS_MP;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const l0 = num("length", 1);
  const t0 = num("time", 1);
  if (l0 === null || t0 === null || l0 === 0 || t0 === 0) return null;
  let rho0: number | null;
  if (u["mass"] !== undefined) {
    const m0 = num("mass", NaN);
    rho0 = m0 !== null && Number.isFinite(m0) ? m0 / l0 ** 3 : null;
  } else {
    rho0 = num("density", 1);
  }
  if (rho0 === null) return null;
  const vel0 = l0 / t0;
  return { l0, t0, rho0, m0: rho0 * l0 ** 3, vel0, ene0: rho0 * vel0 ** 2 };
}

function fmt(x: number): string {
  if (x === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(x)));
  if (e >= -3 && e < 6) return String(Number(x.toPrecision(4)));
  return x.toExponential(3);
}

function UnitCard({ spec, mutate }: { spec: Spec; mutate: Mutate }) {
  const mode = unitMode(spec);
  const u = spec.sections["unit"] ?? {};
  const s = unitSummary(spec);
  const problems: string[] = [];
  if (s) {
    for (const [k, v] of Object.entries({
      m0: s.m0, vel0: s.vel0, ene0: s.ene0,
    })) {
      if (Math.abs(v) > F32_MAX)
        problems.push(
          `${k}=${v.toExponential(2)} overflows float32 ` +
            `(kratos throws "Unit sys overflow")`,
        );
      else if (v !== 0 && Math.abs(v) < F32_MIN_NORMAL)
        problems.push(`${k}=${v.toExponential(2)} underflows float32`);
    }
  }
  return (
    <div className="card">
      <div className="cardhead">
        <h3>[unit]</h3>
        <span className="hint">code-unit anchoring (CGS)</span>
      </div>
      <NumField spec={spec} sec="unit" k="length" label="length (cm)" mutate={mutate} />
      <NumField spec={spec} sec="unit" k="time" label="time (s)" mutate={mutate} />
      <Row label="anchor">
        <select
          value={mode}
          onChange={(e) => {
            const m = e.target.value as UnitMode;
            mutate((sp) => {
              const sec = (sp.sections["unit"] ??= {});
              if (m === "mass") {
                delete sec["density"];
                sec["mass"] = 1;
              } else {
                delete sec["mass"];
                sec["density"] = 1;
              }
              return sp;
            });
          }}
        >
          <option value="density">density</option>
          <option value="mass">mass</option>
        </select>
        {mode === "density" ? (
          <>
            <span className="hint">density (g/cm³ or mp/mh)</span>
            <DraftInput
              value={
                u["density"] === undefined ? "" : String(u["density"])
              }
              placeholder="1 | mp | mh"
              onCommit={(t) => {
                const x = t.trim();
                if (x === "mp" || x === "mh")
                  setKey(mutate, "unit", "density", x);
                else {
                  const n = parseNum(x);
                  if (n !== null) setKey(mutate, "unit", "density", n);
                }
              }}
            />
          </>
        ) : (
          <>
            <span className="hint">mass (g)</span>
            <DraftInput
              value={u["mass"] === undefined ? "" : String(u["mass"])}
              placeholder="1"
              onCommit={(t) => {
                const n = parseNum(t);
                if (n !== null) setKey(mutate, "unit", "mass", n);
              }}
            />
          </>
        )}
      </Row>
      {s && (
        <p className="hint">
          derived: m0={fmt(s.m0)} g · rho0={fmt(s.rho0)} g/cm³ · vel0=
          {fmt(s.vel0)} cm/s · ene0={fmt(s.ene0)} erg/cm³
        </p>
      )}
      {problems.map((p) => (
        <p key={p} className="issue error">
          {p}
        </p>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* [mesh]                                                              */
/* ------------------------------------------------------------------ */

function MeshCard({ spec, mutate }: { spec: Spec; mutate: Mutate }) {
  const g = getVec(spec, "mesh", "n_cell_global");
  const b = getVec(spec, "mesh", "n_cell_block");
  let blocksInfo: string | null = null;
  const errs: string[] = [];
  if (g && g.length === 3) {
    const bb = b && b.length === 3 ? b : g;
    let nDim = 0;
    for (let a = 0; a < 3; a++) if (g[a] > 1) nDim = a + 1;
    let total = 1;
    const per: number[] = [];
    for (let a = 0; a < nDim; a++) {
      if (g[a] === 0) {
        errs.push(`n_cell_global[${a}] = 0 (kratos: "Zero mesh size")`);
        continue;
      }
      if (bb[a] <= 0 || g[a] % bb[a] !== 0) {
        errs.push(
          `axis ${a}: ${g[a]} indivisible by block ${bb[a]} ` +
            `(kratos: "Mesh size indivisible by sub-mesh.")`,
        );
      } else {
        per.push(g[a] / bb[a]);
        total *= g[a] / bb[a];
      }
    }
    if (!errs.length)
      blocksInfo = `blocks: ${per.join("×")} = ${total} total`;
  }
  return (
    <div className="card">
      <div className="cardhead">
        <h3>[mesh]</h3>
        <span className="hint">domain geometry + block layout</span>
      </div>
      <Vec3Field spec={spec} sec="mesh" k="x_min" label="x_min" mutate={mutate} />
      <Vec3Field spec={spec} sec="mesh" k="x_max" label="x_max" mutate={mutate} />
      <Vec3Field
        spec={spec} sec="mesh" k="n_cell_global"
        label="n_cell_global" mutate={mutate}
      />
      <Vec3Field
        spec={spec} sec="mesh" k="n_cell_block"
        label="n_cell_block" mutate={mutate}
      />
      {blocksInfo && <p className="hint">{blocksInfo}</p>}
      {errs.map((e) => (
        <p key={e} className="issue error">
          {e}
        </p>
      ))}
      <Row label="dist_mode">
        <select
          value={getNum(spec, "mesh", "dist_mode") ?? 1}
          onChange={(e) =>
            setKey(mutate, "mesh", "dist_mode", Number(e.target.value))
          }
        >
          <option value={1}>1 (fractal)</option>
          <option value={0}>0 (default)</option>
        </select>
        <label className="hint" style={{ marginLeft: "1ch" }}>
          <input
            type="checkbox"
            checked={getNum(spec, "mesh", "geo_regenerate") === 1}
            onChange={(e) =>
              setKey(mutate, "mesh", "geo_regenerate", e.target.checked ? 1 : 0)
            }
          />{" "}
          geo_regenerate
        </label>
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* [cycle] + [device]                                                  */
/* ------------------------------------------------------------------ */

function CycleCard({ spec, mutate }: { spec: Spec; mutate: Mutate }) {
  return (
    <div className="card">
      <div className="cardhead">
        <h3>[cycle]</h3>
        <span className="hint">time integration + output cadence</span>
      </div>
      <NumField spec={spec} sec="cycle" k="t_0" label="t_0" mutate={mutate} />
      <NumField spec={spec} sec="cycle" k="t_lim" label="t_lim" mutate={mutate} />
      <NumField spec={spec} sec="cycle" k="dt_init" label="dt_init" mutate={mutate} />
      <NumField spec={spec} sec="cycle" k="dt_expand" label="dt_expand" mutate={mutate} />
      <NumField
        spec={spec} sec="cycle" k="n_cycle_lim"
        label="n_cycle_lim" mutate={mutate}
      />
      <NumField
        spec={spec} sec="cycle" k="dt_output"
        label="dt_output" mutate={mutate}
      />
      <NumField
        spec={spec} sec="cycle" k="t_output_next"
        label="t_output_next" mutate={mutate}
      />
      <Row label="prefix_output">
        <DraftInput
          value={String(spec.sections["cycle"]?.["prefix_output"] ?? "")}
          placeholder="out"
          onCommit={(t) => setKey(mutate, "cycle", "prefix_output", t)}
        />
      </Row>
    </div>
  );
}

function DeviceCard({ spec, mutate }: { spec: Spec; mutate: Mutate }) {
  return (
    <div className="card">
      <div className="cardhead">
        <h3>[device]</h3>
        <span className="hint">target device</span>
      </div>
      <NumField
        spec={spec} sec="device" k="idx_device"
        label="idx_device" mutate={mutate} placeholder="0"
      />
      <p className="hint">
        HIPCPU builds only have device 0; CUDA: pick an idle GPU
        (nvidia-smi).
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function GlobalsView({
  spec,
  mutate,
}: {
  spec: Spec;
  mutate: Mutate;
  issues?: Issue[];
}) {
  return (
    <div className="formgrid">
      <UnitCard spec={spec} mutate={mutate} />
      <MeshCard spec={spec} mutate={mutate} />
      <CycleCard spec={spec} mutate={mutate} />
      <DeviceCard spec={spec} mutate={mutate} />
    </div>
  );
}
