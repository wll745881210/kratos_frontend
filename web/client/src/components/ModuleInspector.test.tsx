import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Issue, SectionDescriptor, Spec } from "../model/types";
import { CoreInspector, ModuleInspector } from "./ModuleInspector";

const DESCS: SectionDescriptor[] = [
  {
    section: "dynamics",
    title: "dynamics",
    order: 40,
    doc: "",
    wildcard: false,
    keys: [
      { name: "gamma", type: "float", required: false, default: 1.4, doc: "" },
      { name: "cfl", type: "float", required: false, default: 0.3, doc: "" },
    ],
  },
  {
    section: "ic*",
    title: "ic",
    order: 56,
    doc: "",
    wildcard: true,
    keys: [
      { name: "mask", type: "any", required: false, default: "1", doc: "" },
      { name: "rho", type: "any", required: false, default: "", doc: "" },
    ],
  },
];

const SPEC: Spec = {
  version: 1,
  meta: {},
  sections: {
    "module.flow": { type: "hydro", order: 0 },
    "flow.dynamics": { gamma: 1.4 },
    "flow.ic.left": { mask: "x < 0.5", rho: 1, "x.H2": 0.9 },
    "flow.ic.right": { mask: "x geq 0.5", rho: 0.125 },
  },
};

const ISSUES: Issue[] = [
  { level: "warning", where: "flow.dynamics.cfl", message: "unknown-ish" },
];

function setup() {
  const mutate = vi.fn();
  render(
    <ModuleInspector
      spec={SPEC}
      descs={DESCS}
      issues={ISSUES}
      role="flow"
      mutate={mutate}
      onClose={() => {}}
    />,
  );
  return mutate;
}

describe("ModuleInspector", () => {
  it("shows module header, params and IC regions", () => {
    setup();
    expect(screen.getByText("flow")).toBeInTheDocument();
    expect(screen.getByText("[flow.dynamics]")).toBeInTheDocument();
    expect(screen.getByText("[flow.ic.left]")).toBeInTheDocument();
    expect(screen.getByText("[flow.ic.right]")).toBeInTheDocument();
  });

  it("edits a key through mutate", () => {
    const mutate = setup();
    // gamma field: labeled input via FieldInput
    const gamma = screen.getByDisplayValue("1.4");
    fireEvent.change(gamma, { target: { value: "1.666" } });
    fireEvent.blur(gamma);
    expect(mutate).toHaveBeenCalled();
  });

  it("adds an IC region", () => {
    const mutate = setup();
    fireEvent.change(screen.getByPlaceholderText("+ IC region"), {
      target: { value: "band" },
    });
    fireEvent.click(screen.getByText("add region"));
    expect(mutate).toHaveBeenCalled();
  });

  it("offers missing sections from the module's type", () => {
    setup();
    const sel = screen.getByText("+ section…").closest("select")!;
    const opts = Array.from(sel.options).map((o) => o.value);
    expect(opts).toContain("init");
  });

  it("raw adder allows x.<species> keys in regions", () => {
    setup();
    // species channel value is rendered (0.9) and a raw key adder exists
    expect(screen.getByDisplayValue("0.9")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("+ new key").length).toBeGreaterThan(0);
  });
});

describe("CoreInspector", () => {
  const CORE_DESCS: SectionDescriptor[] = [
    {
      section: "unit",
      title: "Unit system",
      order: 20,
      doc: "",
      wildcard: false,
      keys: [
        { name: "length", type: "float", required: false, default: 1, doc: "" },
        { name: "time", type: "float", required: false, default: 1, doc: "" },
      ],
    },
  ];

  it("edits an existing global section in place", () => {
    const mutate = vi.fn();
    const spec: Spec = {
      version: 1, meta: {},
      sections: { unit: { length: 2, time: 3.1557e13 } },
    };
    render(
      <CoreInspector
        spec={spec} descs={CORE_DESCS} issues={[]}
        section="unit" mutate={mutate} onClose={() => {}}
      />,
    );
    expect(screen.getAllByText("[unit]").length).toBeGreaterThan(0);
    expect(screen.getByText("global section")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("2"), {
      target: { value: "4" },
    });
    expect(mutate).toHaveBeenCalled();
  });

  it("offers creation for an unset section, with identity unit", () => {
    const mutate = vi.fn();
    render(
      <CoreInspector
        spec={{ version: 1, meta: {}, sections: {} } as Spec}
        descs={CORE_DESCS} issues={[]}
        section="unit" mutate={mutate} onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("create [unit]"));
    expect(mutate).toHaveBeenCalledWith(expect.any(Function));
    // template carries the identity unit
    const s = { sections: {} } as Spec;
    (mutate.mock.calls[0][0] as (s: Spec) => Spec)(s);
    expect(s.sections["unit"]).toEqual({ length: 1, time: 1, density: 1 });
  });
});
