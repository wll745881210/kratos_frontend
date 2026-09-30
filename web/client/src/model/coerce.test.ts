import { describe, expect, it } from "vitest";
import { fromText, inferRaw, rawToText, toText } from "./coerce";

describe("toText", () => {
  it("scalars render as a single box", () => {
    expect(toText("int", 3)).toEqual(["3"]);
    expect(toText("float", 0.25)).toEqual(["0.25"]);
    expect(toText("str", "hllc")).toEqual(["hllc"]);
  });
  it("bool renders as 0/1", () => {
    expect(toText("bool", true)).toEqual(["1"]);
    expect(toText("bool", false)).toEqual(["0"]);
  });
  it("vec3 renders three boxes, padding/truncating as needed", () => {
    expect(toText("fvec3", [1, 2, 3])).toEqual(["1", "2", "3"]);
    expect(toText("fvec3", [1])).toEqual(["1", "", ""]);
    expect(toText("fvec3", 5)).toEqual(["5", "", ""]);
  });
  it("arrays join with spaces", () => {
    expect(toText("int[]", [64, 64, 1])).toEqual(["64 64 1"]);
    expect(toText("str[]", ["fre", "out"])).toEqual(["fre out"]);
  });
});

describe("fromText", () => {
  it("parses ints and floats, accepting scientific notation", () => {
    expect(fromText("int", ["64"])).toBe(64);
    expect(fromText("float", ["3.156e+13"])).toBe(3.156e13);
  });
  it("rejects non-integral ints", () => {
    expect(() => fromText("int", ["1.5"])).toThrow();
  });
  it("parses bool from 1/true", () => {
    expect(fromText("bool", ["1"])).toBe(true);
    expect(fromText("bool", ["0"])).toBe(false);
  });
  it("vec3 needs exactly three components", () => {
    expect(fromText("fvec3", ["0", "1.5", "-2"])).toEqual([0, 1.5, -2]);
    expect(() => fromText("fvec3", ["0", "1", ""])).toThrow();
  });
  it("arrays split on whitespace", () => {
    expect(fromText("int[]", ["64  64 1"])).toEqual([64, 64, 1]);
    expect(fromText("str[]", ["per out"])).toEqual(["per", "out"]);
  });
  it("any infers numbers, keeps strings", () => {
    expect(fromText("any", ["mp"])).toBe("mp");
    expect(fromText("any", ["1.67e-24"])).toBe(1.67e-24);
  });
});

describe("inferRaw / rawToText", () => {
  it("infers scalars, lists, and mixed lists", () => {
    expect(inferRaw("1.5")).toBe(1.5);
    expect(inferRaw("per per out")).toEqual(["per", "per", "out"]);
    expect(inferRaw("x 1")).toEqual(["x", 1]);
    expect(inferRaw("")).toBe("");
  });
  it("round-trips through rawToText", () => {
    expect(rawToText(inferRaw("64 64 1"))).toBe("64 64 1");
    expect(rawToText(inferRaw("hllc"))).toBe("hllc");
  });
});
