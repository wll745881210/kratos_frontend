/** Value <-> editable-text conversion, mirroring core/kratos_spec/values.py
 * and the descriptor TYPES.  The server stays authoritative; these helpers
 * only shape the form widgets.
 */

import type { Value } from "./types";

export const SCALAR_TYPES = new Set(["int", "float", "str", "bool", "any"]);
export const VEC3_TYPES = new Set(["fvec3", "ivec3"]);
export const ARRAY_TYPES = new Set(["int[]", "float[]", "str[]"]);

export function isVec3(t: string): boolean {
  return VEC3_TYPES.has(t);
}
export function isArray(t: string): boolean {
  return ARRAY_TYPES.has(t);
}

/** Render a Value as one string per input box (vec3 -> 3, else 1). */
export function toText(type: string, value: Value | null | undefined): string[] {
  if (value === null || value === undefined) {
    return isVec3(type) ? ["", "", ""] : [""];
  }
  if (isVec3(type)) {
    const arr = Array.isArray(value) ? value : [value];
    const out = arr.map((v) => String(v));
    while (out.length < 3) out.push("");
    return out.slice(0, 3);
  }
  if (isArray(type)) {
    return [Array.isArray(value) ? value.map(String).join(" ") : String(value)];
  }
  if (type === "bool") return [value === true ? "1" : "0"];
  return [String(value)];
}

function parseNumber(raw: string, type: string): number {
  const t = raw.trim();
  if (t === "") throw new Error("empty value");
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
  if (type.startsWith("int") && !Number.isInteger(n))
    throw new Error(`not an integer: ${raw}`);
  return n;
}

/** Parse input-box text(s) back into a typed Value; throws on bad input. */
export function fromText(type: string, texts: string[]): Value {
  if (type === "bool") return texts[0] === "1" || texts[0] === "true";
  if (type === "int" || type === "float")
    return parseNumber(texts[0], type);
  if (type === "str") return texts[0];
  if (type === "any") return inferRaw(texts[0]);
  if (isVec3(type)) {
    if (texts.length !== 3 || texts.some((t) => t.trim() === ""))
      throw new Error(`${type} needs exactly 3 components`);
    return texts.map((t) => parseNumber(t, type));
  }
  if (isArray(type)) {
    const toks = texts[0].trim().split(/\s+/).filter((t) => t !== "");
    if (type === "str[]") return toks;
    return toks.map((t) => parseNumber(t, type));
  }
  return texts[0]; // unknown type: passthrough
}

/** Type inference for undescribed (raw passthrough) keys, mirroring
 * values.py::infer_value. */
export function inferRaw(text: string): Value {
  const toks = text.trim().split(/\s+/).filter((t) => t !== "");
  if (toks.length === 0) return "";
  const conv = (t: string): Value => {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  };
  if (toks.length === 1) return conv(toks[0]);
  return toks.map(conv);
}

/** Display string for a raw value of unknown type. */
export function rawToText(value: Value): string {
  return Array.isArray(value) ? value.map(String).join(" ") : String(value);
}
