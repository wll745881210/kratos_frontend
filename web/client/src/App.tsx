import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { SectionDescriptor } from "./model/types";
import { ParEditor } from "./views/ParEditor";

export default function App() {
  const [descs, setDescs] = useState<SectionDescriptor[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .descriptors()
      .then((r) => setDescs(r.sections))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, []);

  if (err)
    return (
      <div className="fatal">
        <h1>kratos frontend</h1>
        <p>cannot reach the server: {err}</p>
        <p>
          start it with <code>kratos-front serve</code>
        </p>
      </div>
    );
  if (!descs) return <div className="fatal">loading descriptors…</div>;
  const initialFile = new URLSearchParams(window.location.search).get("file");
  return <ParEditor descs={descs} initialFile={initialFile} />;
}
