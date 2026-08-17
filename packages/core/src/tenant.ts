import path from "node:path";

import type { TenantIdentity } from "@private-fund/contracts";

export interface TenantContext extends TenantIdentity {
  readonly root: string;
  readonly projectsRoot: string;
  readonly sessionsRoot: string;
  readonly cacheRoot: string;
}

export function buildTenantContext(dataRoot: string, identity: TenantIdentity): TenantContext {
  const root = path.resolve(dataRoot, "users", identity.dataNamespace);
  return {
    ...identity,
    root,
    projectsRoot: path.join(root, "projects"),
    sessionsRoot: path.join(root, "pi-sessions"),
    cacheRoot: path.join(root, "cache"),
  };
}
