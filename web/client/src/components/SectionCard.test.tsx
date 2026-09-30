import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SectionDescriptor } from "../model/types";
import { SectionCard } from "./SectionCard";

const MESH_DESC: SectionDescriptor = {
  section: "mesh",
  title: "computational domain",
  order: 20,
  doc: "",
  wildcard: false,
  keys: [
    { name: "x_min", type: "fvec3", required: true, default: [0, 0, 0],
      doc: "lower corner" },
    { name: "x_max", type: "fvec3", required: true, default: [1, 1, 1],
      doc: "upper corner" },
    { name: "n_cell_global", type: "ivec3", required: true,
      default: [64, 64, 1], doc: "" },
    { name: "refine_on", type: "bool", required: false, default: false,
      doc: "" },
  ],
};

const noop = () => {};

function renderCard(over: Partial<Parameters<typeof SectionCard>[0]> = {}) {
  const props = {
    name: "mesh",
    desc: MESH_DESC,
    values: { x_min: [0, 0, 0], x_max: [1, 1, 1] },
    issues: [],
    onSet: vi.fn(),
    onRemoveKey: vi.fn(),
    onRemoveSection: vi.fn(),
    ...over,
  };
  const utils = render(<SectionCard {...props} />);
  return { props, ...utils };
}

describe("SectionCard (descriptor mode)", () => {
  it("renders present keys and offers the missing ones", () => {
    renderCard();
    expect(screen.getByText("n_cell_global")).toBeInTheDocument();
    expect(screen.getByText("refine_on")).toBeInTheDocument();
    expect(screen.queryByText("+ new key")).not.toBeInTheDocument();
  });

  it("adds a missing key with its descriptor default", () => {
    const { props } = renderCard();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "n_cell_global" },
    });
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    expect(props.onSet).toHaveBeenCalledWith("n_cell_global", [64, 64, 1]);
  });

  it("surfaces section-level issues", () => {
    renderCard({
      issues: [{ level: "error", where: "mesh", message: "bad section" }],
    });
    expect(screen.getByText("bad section")).toBeInTheDocument();
  });
});

describe("SectionCard (raw mode, no descriptor)", () => {
  it("renders raw keys and accepts free-form new keys", () => {
    const onSet = vi.fn();
    render(<SectionCard
      name="prob"
      desc={null}
      values={{ v0_cgs: 1e5 }}
      issues={[]}
      onSet={onSet}
      onRemoveKey={noop}
      onRemoveSection={noop}
    />);
    expect(screen.getByText("raw")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("+ new key");
    const add = screen.getByRole("button", { name: "add" });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "pert_amp" } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onSet).toHaveBeenCalledWith("pert_amp", "");
  });

  it("rejects illegal key names", () => {
    render(<SectionCard
      name="prob"
      desc={null}
      values={{}}
      issues={[]}
      onSet={noop}
      onRemoveKey={noop}
      onRemoveSection={noop}
    />);
    const input = screen.getByPlaceholderText("+ new key");
    fireEvent.change(input, { target: { value: "1bad key" } });
    expect(screen.getByRole("button", { name: "add" })).toBeDisabled();
  });
});

describe("SectionCard (described section with extra raw keys)", () => {
  it("keeps showing undescribed keys present in the par", () => {
    renderCard({ values: { x_min: [0, 0, 0], custom_flag: 3 } });
    expect(screen.getByText("x_min")).toBeInTheDocument();
    expect(screen.getByText("custom_flag")).toBeInTheDocument();
  });
});
