import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IcPreview, Spec } from "../model/types";
import { PreviewView } from "./PreviewView";

const SPEC: Spec = {
  version: 1,
  meta: {},
  sections: {
    mesh: {
      x_min: [0, 0, 0],
      x_max: [1, 1, 1],
      n_cell_global: [128, 4, 1],
    },
    init: { rho0: 1, pre0: 1, vel0: 0 },
    "ic.left": { mask: "x < 0.5", rho: 1, pre: 1 },
    "ic.right": { mask: ["x", "geq", "0.5"], rho: 0.125, pre: 0.1 },
  },
};

const PREVIEW: IcPreview = {
  axis: 2,
  index: 0,
  coord: 0.5,
  u: { axis: 0, name: "x", min: 0, max: 1, n: 8 },
  v: { axis: 1, name: "y", min: 0, max: 1, n: 4 },
  fields: {
    rho: {
      data: [
        [1, 1, 1, 1, 0.125, 0.125, 0.125, 0.125],
        [1, 1, 1, 1, 0.125, 0.125, 0.125, 0.125],
        [1, 1, 1, 1, 0.125, 0.125, 0.125, 0.125],
        [1, 1, 1, 1, 0.125, 0.125, 0.125, 0.125],
      ],
      min: 0.125,
      max: 1,
    },
  },
  issues: [],
};

function mockCanvas() {
  const fakeCtx = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (() => fakeCtx) as any,
  );
  return fakeCtx;
}

describe("PreviewView", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockCanvas();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("/api/preview/ic");
        return {
          ok: true,
          json: async () => PREVIEW,
        } as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches and renders an IC slice after the debounce", async () => {
    render(<PreviewView spec={SPEC} />);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/rho ∈ \[/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/0.125/)).toBeInTheDocument();
  });

  it("shows a hint when [mesh] is missing", () => {
    render(<PreviewView spec={{ version: 1, meta: {}, sections: {} }} />);
    expect(screen.getByText(/needs \[mesh\]/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
