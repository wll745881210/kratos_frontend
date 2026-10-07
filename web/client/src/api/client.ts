/** Typed fetch client for the kratos_server REST API (v1). */

import type { BinPreview, Blocklib, FsEntry, IcPreview, Issue, SectionDescriptor, Spec } from "../model/types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      if (body && body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(r.status, detail);
  }
  return (await r.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    detail: string,
  ) {
    super(detail);
  }
}

function post<T>(path: string, body: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  health: () => req<{ status: string; spec_version: number }>("/api/health"),

  descriptors: () =>
    req<{ sections: SectionDescriptor[] }>("/api/descriptors"),

  blocklib: () => req<Blocklib>("/api/blocklib"),

  parsePar: (text: string) =>
    post<{ spec: Spec; issues: Issue[] }>("/api/par/parse", { text }),

  emitPar: (spec: Spec) =>
    post<{ text: string | null; issues: Issue[] }>("/api/spec/emit", { spec }),

  validateSpec: (spec: Spec) =>
    post<{ issues: Issue[] }>("/api/spec/validate", { spec }),

  readFile: (path: string) =>
    req<{ path: string; text: string }>(
      `/api/fs/read?path=${encodeURIComponent(path)}`,
    ),

  writeFile: (path: string, text: string) =>
    post<{ path: string; bytes: number }>("/api/fs/write", { path, text }),

  listDir: (dir: string) =>
    req<{ dir: string; entries: FsEntry[] }>(
      `/api/fs/list?dir=${encodeURIComponent(dir)}`,
    ),

  cwd: () => req<{ cwd: string; roots: string[] }>("/api/app/cwd"),

  setCwd: (dir: string) =>
    post<{ roots: string[] }>("/api/app/set-cwd", { dir }),

  /** Server-side IC evaluation: 2D base-mesh slice of primitive fields. */
  previewIc: (spec: Spec, axis: number, index?: number, maxDim?: number) =>
    post<IcPreview>("/api/preview/ic", {
      spec,
      axis,
      ...(index !== undefined ? { index } : {}),
      ...(maxDim !== undefined ? { max_dim: maxDim } : {}),
    }),

  /** Read a kratos .bin output: exact AMR block list + optional slice. */
  previewBin: (
    path: string,
    field?: string,
    opts?: { block?: string; component?: number; axis?: number; index?: number },
  ) =>
    post<BinPreview>("/api/preview/bin", {
      path,
      ...(field ? { field } : {}),
      ...(opts?.block ? { block: opts.block } : {}),
      ...(opts?.component !== undefined ? { component: opts.component } : {}),
      ...(opts?.axis !== undefined ? { axis: opts.axis } : {}),
      ...(opts?.index !== undefined ? { index: opts.index } : {}),
    }),

  // ---- project / bundle (M2.4) ----
  projectInit: (dir: string, text?: string, arch?: string) =>
    post<{ dir: string; manifest: Record<string, unknown> }>(
      "/api/project/init",
      { dir, ...(text !== undefined ? { text } : {}), ...(arch ? { arch } : {}) },
    ),

  projectLoad: (dir: string) =>
    req<{ dir: string; manifest: Record<string, unknown> }>(
      `/api/project/load?dir=${encodeURIComponent(dir)}`,
    ),

  projectSave: (dir: string, manifest: Record<string, unknown>) =>
    post<{ dir: string; saved: boolean }>("/api/project/save", {
      dir,
      manifest,
    }),

  projectCheck: (dir: string) =>
    post<{ dir: string; issues: Issue[] }>("/api/project/check", { dir }),

  bundleExport: (dir: string, out?: string) =>
    post<{ bundle: string }>("/api/bundle/export", {
      dir,
      ...(out ? { out } : {}),
    }),

  bundleImport: (bundle: string, dir: string, override?: unknown) =>
    post<{ dir: string; issues: Issue[] }>("/api/bundle/import", {
      bundle,
      dir,
      ...(override ? { override } : {}),
    }),
};
