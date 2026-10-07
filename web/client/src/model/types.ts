/** Wire types mirroring the kratos_server REST API (v1). */

export type Value = number | string | boolean | Value[];

export interface Spec {
  version: number;
  meta: Record<string, unknown>;
  sections: Record<string, Record<string, Value>>;
}

export interface Issue {
  level: "error" | "warning";
  where: string; // "section.key"
  message: string;
}

export interface KeySpec {
  name: string;
  type: string; // any|int|float|str|bool|int[]|float[]|str[]|fvec3|ivec3
  required: boolean;
  default: Value | null;
  doc: string;
}

export interface SectionDescriptor {
  section: string; // exact name or trailing-"*" wildcard
  title: string;
  order: number;
  doc: string;
  wildcard: boolean;
  keys: KeySpec[];
}

export interface FsEntry {
  name: string;
  type: "file" | "dir";
}

/** Module block library (GET /api/blocklib; mirrors the C++ container). */
export interface BlocklibModule {
  type: string;
  sections: string[]; // native section names the module reads
  params: Record<string, KeySpec[]>;
}

export interface Blocklib {
  modules: BlocklibModule[];
  couplings: Record<string, Record<string, string>>; // type -> slot -> doc
  reserved_roles: string[];
  /** type -> slot -> allowed target module types (C++ mirror). */
  slot_targets?: Record<string, Record<string, string[]>>;
}

/** IC slice preview result (server ic_eval). */
export interface IcPreview {
  axis: number;
  index: number;
  coord: number;
  u: { axis: number; name: string; min: number; max: number; n: number };
  v: { axis: number; name: string; min: number; max: number; n: number };
  fields: Record<
    string,
    { data: number[][]; min: number | null; max: number | null }
  >;
  issues: Issue[];
}

/** .bin output preview (server binread; exact AMR blocks + slice). */
export interface BinBlockInfo {
  name: string;
  level: number;
  xf0: number[];
  dx0: number[];
  n_cell: number[];
}

export interface BinSlice {
  block: string;
  field: string;
  component: number;
  axis: number;
  index: number;
  n_index: number;
  shape: number[];
  extent: number[]; // [h0, h1, v0, v1] in plane coordinates
  min: number | null;
  max: number | null;
  data: (number | null)[][];
}

export interface BinPreview {
  path: string;
  globals: Record<string, number>;
  blocks: BinBlockInfo[];
  fields: Record<string, string[]>;
  slice?: BinSlice;
}
