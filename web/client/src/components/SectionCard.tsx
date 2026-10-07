import { useState } from "react";
import type { Issue, SectionDescriptor, Value } from "../model/types";
import { FieldInput } from "./FieldInput";

interface Props {
  name: string;
  desc: SectionDescriptor | null; // null -> undescribed (raw passthrough)
  values: Record<string, Value>;
  issues: Issue[]; // issues for this section
  onSet: (key: string, v: Value) => void;
  onRemoveKey: (key: string) => void;
  onRemoveSection: () => void;
  onRenameSection?: (next: string) => void;
  /** Also offer a free-form key adder when a descriptor exists
   *  (IC regions need arbitrary x.<species> channels). */
  rawAddKeys?: boolean;
}

/** One par section: descriptor-driven form or raw key-value table. */
export function SectionCard({
  name, desc, values, issues, onSet, onRemoveKey, onRemoveSection, rawAddKeys,
}: Props) {
  const [addKey, setAddKey] = useState("");
  const known = new Map((desc?.keys ?? []).map((k) => [k.name, k]));
  const present = Object.keys(values);
  const missing = (desc?.keys ?? []).filter((k) => !(k.name in values));
  const issueFor = (key: string) =>
    issues.filter((i) => i.where === `${name}.${key}`);
  const sectionIssues = issues.filter((i) => i.where === name);

  return (
    <div className="card" id={`sec-${name}`}>
      <div className="card-head">
        <span className="card-title">[{name}]</span>
        {desc?.title && <span className="card-sub">{desc.title}</span>}
        {!desc && <span className="card-sub raw">raw</span>}
        <button className="field-del" title="remove section" onClick={onRemoveSection}>
          ×
        </button>
      </div>
      {desc?.doc && <div className="card-doc">{desc.doc}</div>}
      {sectionIssues.map((i, k) => (
        <div key={k} className={"issue " + i.level}>{i.message}</div>
      ))}
      {present.map((key) => (
        <FieldInput
          key={key}
          keyName={key}
          spec={known.get(key) ?? null}
          value={values[key]}
          issues={issueFor(key)}
          onChange={(v) => onSet(key, v)}
          onRemove={() => onRemoveKey(key)}
        />
      ))}
      {missing.length > 0 && (
        <div className="add-key">
          <select value={addKey} onChange={(e) => setAddKey(e.target.value)}>
            <option value="">+ add key…</option>
            {missing.map((k) => (
              <option key={k.name} value={k.name}>{k.name}</option>
            ))}
          </select>
          <button
            disabled={!addKey}
            onClick={() => {
              const ks = known.get(addKey);
              if (!ks) return;
              onSet(addKey, (ks.default ?? "") as Value);
              setAddKey("");
            }}
          >
            add
          </button>
        </div>
      )}
      {(!desc || rawAddKeys) && (
        <div className="add-key">
          <RawKeyAdder onAdd={(k) => onSet(k, "")} />
        </div>
      )}
    </div>
  );
}

function RawKeyAdder({ onAdd }: { onAdd: (key: string) => void }) {
  const [name, setName] = useState("");
  return (
    <>
      <input
        placeholder="+ new key"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
      />
      <button
        disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)}
        onClick={() => { onAdd(name); setName(""); }}
      >
        add
      </button>
    </>
  );
}
