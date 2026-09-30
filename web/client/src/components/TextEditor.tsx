import { EditorView, basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (text: string) => void;
}

/** Minimal CodeMirror 6 wrapper for raw par text. */
export function TextEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      doc: latest.current,
      extensions: [
        basicSetup,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
        EditorView.theme({}, { dark: false }),
      ],
      parent: host.current,
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external replacement (file open / tab switch) resets the doc
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="cm-host" ref={host} />;
}
