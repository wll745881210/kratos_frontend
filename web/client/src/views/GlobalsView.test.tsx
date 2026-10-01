// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Spec } from "../model/types";
import { GlobalsView } from "./GlobalsView";

afterEach(cleanup);

const SPEC: Spec = {
  version: 1,
  meta: {},
  sections: {
    unit: { length: 3.085677581e18, time: 3.15576e13, density: "mp" },
    mesh: {
      x_min: [0, 0, 0],
      x_max: [1, 1, 1],
      n_cell_global: [512, 2, 1],
    },
    cycle: { t_0: 0, t_lim: 0.2 },
  },
};

describe("GlobalsView", () => {
  it("renders the core cards", () => {
    render(<GlobalsView spec={SPEC} mutate={() => {}} />);
    expect(screen.getByText("[unit]")).toBeTruthy();
    expect(screen.getByText("[mesh]")).toBeTruthy();
    expect(screen.getByText("[cycle]")).toBeTruthy();
    expect(screen.getByText("[device]")).toBeTruthy();
  });

  it("shows derived CGS units without overflow for pc+mp", () => {
    render(<GlobalsView spec={SPEC} mutate={() => {}} />);
    expect(screen.getByText(/derived: m0=/)).toBeTruthy();
    expect(screen.queryByText(/overflows float32/)).toBeNull();
  });

  it("flags kpc+mp as float32 overflow (m0 ~ 5e40)", () => {
    const bad: Spec = structuredClone(SPEC);
    bad.sections["unit"]["length"] = 3.085677581e21; // 1 kpc
    render(<GlobalsView spec={bad} mutate={() => {}} />);
    expect(screen.getByText(/overflows float32/)).toBeTruthy();
  });

  it("shows mesh block layout derived from n_cell_global/n_cell_block", () => {
    const s: Spec = structuredClone(SPEC);
    s.sections["mesh"]["n_cell_block"] = [128, 2, 1];
    render(<GlobalsView spec={s} mutate={() => {}} />);
    // n_dim = 2 (axes with n>1); degenerate z axis not shown
    expect(screen.getByText("blocks: 4×1 = 4 total")).toBeTruthy();
  });

  it("flags indivisible block layout", () => {
    const s: Spec = structuredClone(SPEC);
    s.sections["mesh"]["n_cell_block"] = [100, 2, 1];
    render(<GlobalsView spec={s} mutate={() => {}} />);
    expect(screen.getByText(/indivisible/)).toBeTruthy();
  });

  it("commits a new unit length through mutate", () => {
    let out: Spec | null = null;
    render(
      <GlobalsView
        spec={SPEC}
        mutate={(fn) => {
          out = fn(structuredClone(SPEC));
        }}
      />,
    );
    // first DraftInput in the unit card is 'length'
    const input = screen.getByDisplayValue(String(3.085677581e18));
    fireEvent.change(input, { target: { value: "3.0e18" } });
    fireEvent.blur(input);
    expect(out).not.toBeNull();
    expect(out!.sections["unit"]["length"]).toBe(3.0e18);
  });
});
