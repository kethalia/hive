import type { ProjectErrorCode } from "./contracts";
export class ProjectDiscoveryError extends Error {
  constructor(public readonly code: ProjectErrorCode) {
    super(code);
  }
}
