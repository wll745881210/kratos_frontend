/** Typed fetch client for the kratos_server REST API (v1). */

import type { FsEntry, Issue, SectionDescriptor, Spec } from "../model/types";

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
};
