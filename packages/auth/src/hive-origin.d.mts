export function getHivePublicOrigin(): string | undefined;
export function withHivePublicOrigin<T>(origin: string, work: () => T): T;
