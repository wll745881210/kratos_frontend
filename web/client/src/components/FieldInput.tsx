import { useEffect, useState } from "react";
import { fromText, inferRaw, isVec3, rawToText, toText } from "../model/coerce";
import type { Issue, KeySpec, Value } from "../model/types";

interface Props {
  keyName: string;
  spec: KeySpec | null; // null -> raw passthrough (undescribed key)
  value: Value;
  issues: Issue[]; // issues for this field
  onChange: (v: Value) => void;
  onRemove?: () => void;
}

/** One key row: label + typed input(s) + doc hint + inline issue. */
export function FieldInput({ keyName, spec, value, issues, onChange, onRemove }: Props) {
  const type = spec ? spec.type : "raw";
  const [texts, setTexts] = useState<string[]>(() =>
    spec ? toText(spec.type, value) : [rawToText(value)],
  );
  const [err, setErr] = useState<string | null>(null);

  // external value change (e.g. re-parse) refreshes the boxes
  useEffect(() => {
    setTexts(spec ? toText(spec.type, value) : [rawToText(value)]);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  const commit = (next: string[]) => {
    setTexts(next);
    try {
      const v = spec ? fromText(spec.type, next) : inferRaw(next[0]);
      setErr(null);
      onChange(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const setAt = (i: number, s: string) => {
    const next = [...texts];
    next[i] = s;
    commit(next);
  };

  const box = (i: number) => (
    <input
      key={i}
      className={"val" + (err || issues.some((x) => x.level === "error") ? " bad" : "")}
      value={texts[i] ?? ""}
      onChange={(e) => setAt(i, e.target.value)}
      spellCheck={false}
    />
  );

  return (
    <div className="field" title={spec?.doc || undefined}>
      <div className="field-head">
        <span className="field-name">{keyName}</span>
        {spec && <span className="field-type">{type}</span>}
        {spec?.required && <span className="field-req">*</span>}
        {onRemove && (
          <button className="field-del" title="remove key" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {spec?.type === "bool" ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : isVec3(type) ? (
        <div className="vec3">{[0, 1, 2].map(box)}</div>
      ) : (
        box(0)
      )}
      {(err || issues.length > 0) && (
        <div className="field-issues">
          {err && <div className="issue error">{err}</div>}
          {issues.map((i, k) => (
            <div key={k} className={"issue " + i.level}>
              {i.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
