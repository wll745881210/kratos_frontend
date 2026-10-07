/**
 * ModuleInspector — in-diagram property editor for one module role.
 *
 * Edits exactly what the universal pgen container reads for that module:
 *   [module.<role>]      type / order (assembly)
 *   [R.<section>]        module parameters (remapped to native names by
 *                        univ_mesh.h scoped_input; global sections act as
 *                        shared defaults, [R.*] overrides per key)
 *   [R.ic.<region>]      IC regions (incl. x.<species> channels)
 *
 * Reuses SectionCard: the descriptor is matched against the
 * role-prefix-stripped (native) name, while all writes go to the full
 * [R.<section>] name.
 */

import { useState } from "react";
import { SectionCard } from "./SectionCard";
import {
  addIcRegion,
  icRegions,
  missingRoleSections,
  MODULE_TYPES,
  roleSections,
  speciesChannelKeys,
  stripRole,
} from "../model/graph";
import { setModuleProp } from "../model/graph";
import type { Issue, SectionDescriptor, Spec } from "../model/types";

interface Props {
  spec: Spec;
  descs: SectionDescriptor[];
  issues: Issue[];
  role: string;
  mutate: (fn: (s: Spec) => Spec) => void;
  onClose: () => void;
}

function matchDesc(
  descs: SectionDescriptor[],
  section: string,
): SectionDescriptor | null {
  for (const d of descs) if (!d.wildcard && d.section === section) return d;
  for (const d of descs)
    if (d.wildcard && section.startsWith(d.section.slice(0, -1))) return d;
  return null;
}

const REGION_SUGGEST = ["left", "right", "base", "band", "patch"];

export function ModuleInspector({
  spec, descs, issues, role, mutate, onClose,
}: Props) {
  const [newRegion, setNewRegion] = useState("");

  const mSec = `module${role ? "." + role : ""}`;
  const mod = spec.sections[mSec] ?? {};
  const type = String(mod.type ?? "");
  const order = mod.order;

  const typeOptions: string[] = (MODULE_TYPES as readonly string[]).includes(
    type,
  )
    ? [...MODULE_TYPES]
    : [type, ...MODULE_TYPES];

  const setProp = (key: "type" | "order", v: string | number | null) =>
    mutate((s) => (setModuleProp(s, role, key, v), s));

  const sections = roleSections(spec, role);
  const regions = icRegions(spec, role);
  const paramSections = sections.filter((n) => !regions.includes(n));
  const missing = missingRoleSections(spec, role, type);

  const addSection = (native: string) =>
    mutate((s) => ((s.sections[`${role}.${native}`] = {}), s));

  const issueFor = (name: string) =>
    issues.filter((i) => i.where === name || i.where.startsWith(name + "."));

  const card = (name: string, isRegion: boolean) => (
    <SectionCard
      key={name}
      name={name}
      desc={matchDesc(descs, stripRole(name))}
      values={spec.sections[name] ?? {}}
      issues={issueFor(name)}
      rawAddKeys={isRegion}
      onSet={(k, v) =>
        mutate((s) => ((s.sections[name][k] = v), s))
      }
      onRemoveKey={(k) =>
        mutate((s) => (delete s.sections[name][k], s))
      }
      onRemoveSection={() => mutate((s) => (delete s.sections[name], s))}
    />
  );

  return (
    <div className="module-inspector">
      <div className="inspector-head">
        <b>{role || "module"}</b>
        <span className="hint">{mSec}</span>
        <button className="field-del" onClick={onClose}>×</button>
      </div>
      <div className="inspector-props">
        <label>
          type{" "}
          <select value={type} onChange={(e) => setProp("type", e.target.value)}>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{t || "?"}</option>
            ))}
          </select>
        </label>
        <label>
          order{" "}
          <input
            type="number"
            value={order === undefined ? "" : String(order)}
            placeholder="auto"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === "") setProp("order", null);
            else setProp("order", Number(v));
          }}
          />
        </label>
      </div>

      {regions.length > 0 && (
        <div className="inspector-group">IC regions (layered in sort order)</div>
      )}
      {regions.map((r) => card(r, true))}
      <div className="add-key">
        <input
          list="ic-region-names"
          placeholder="+ IC region"
          value={newRegion}
          onChange={(e) => setNewRegion(e.target.value)}
          spellCheck={false}
        />
        <datalist id="ic-region-names">
          {REGION_SUGGEST.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          disabled={!newRegion.trim()}
          onClick={() => {
            mutate((s) => (addIcRegion(s, role, newRegion.trim()), s));
            setNewRegion("");
          }}
        >
          add region
        </button>
      </div>

      <div className="inspector-group">Parameters [ {role}.&lt;section&gt; ]</div>
      {paramSections.map((n) => card(n, false))}
      {missing.length > 0 && (
        <div className="add-key">
          <select
            value=""
            onChange={(e) => e.target.value && addSection(e.target.value)}
          >
            <option value="">+ section…</option>
            {missing.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      )}
      {type === "" && (
        <div className="issue warning">
          module has no type — set one before running
        </div>
      )}
      {sections.some((n) => speciesChannelKeys(spec.sections[n] ?? {}).length > 0) && (
        <div className="hint">
          x.&lt;species&gt; channels: species come from the chemistry
          module&apos;s [chemistry] species list
        </div>
      )}
    </div>
  );
}
