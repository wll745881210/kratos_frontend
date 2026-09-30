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
