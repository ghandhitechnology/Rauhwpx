export const DEFAULT_BLOCKED_HOST_SUFFIXES: readonly string[];

export function expandIPv6(host: string): number[] | null;
export function isPrivateIPv6(host: string): boolean;
export function normalizeHost(hostname: string): string;
export function isBlockedHost(
  hostname: string,
  options?: { blockedSuffixes?: readonly string[]; allowSingleLabel?: boolean },
): boolean;
