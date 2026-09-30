import type { Issue } from "../model/types";

/** Validation issues list; click scrolls to the section card. */
export function IssuesPanel({ issues }: { issues: Issue[] }) {
  if (issues.length === 0)
    return <div className="issues ok">no issues</div>;
  return (
    <div className="issues">
      {issues.map((i, k) => (
        <div
          key={k}
          className={"issue " + i.level}
          onClick={() => {
            // where = "section.key"; section names may contain dots
            // (e.g. "ic.left.mask") while keys never do.
            const sec = i.where.slice(0, i.where.lastIndexOf("."));
            document.getElementById(`sec-${sec}`)?.scrollIntoView({
              behavior: "smooth", block: "start",
            });
          }}
          title={i.where}
        >
          <b>{i.where}</b> — {i.message}
        </div>
      ))}
    </div>
  );
}
