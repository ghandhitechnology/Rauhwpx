export const UNIQUE_INSTALLS_PUBLIC_URL =
  'https://rau-credits-production.up.railway.app/unique-installs';

export interface UniqueInstallSnapshot {
  uniqueInstalls: number | null;
  publicUrl?: string | null;
  recorded?: boolean;
  unavailable?: boolean;
}

interface UniqueInstallHost {
  rhwpDesktop?: {
    getUniqueInstalls?: () => Promise<UniqueInstallSnapshot | null | undefined>;
  };
}

export function formatUniqueInstallCount(count: number): string {
  return new Intl.NumberFormat('ko-KR').format(count);
}

export function uniqueInstallPublicUrl(snapshot?: UniqueInstallSnapshot | null): string {
  const url = typeof snapshot?.publicUrl === 'string' ? snapshot.publicUrl.trim() : '';
  return url || UNIQUE_INSTALLS_PUBLIC_URL;
}

export async function loadUniqueInstallSnapshot(
  host: UniqueInstallHost = globalThis as UniqueInstallHost,
): Promise<UniqueInstallSnapshot> {
  const read = host.rhwpDesktop?.getUniqueInstalls;
  if (typeof read !== 'function') {
    return { uniqueInstalls: null, publicUrl: UNIQUE_INSTALLS_PUBLIC_URL };
  }
  try {
    const snapshot = await read();
    if (!snapshot || typeof snapshot !== 'object') {
      return { uniqueInstalls: null, publicUrl: UNIQUE_INSTALLS_PUBLIC_URL, unavailable: true };
    }
    const uniqueInstalls = Number.isSafeInteger(snapshot.uniqueInstalls)
      && (snapshot.uniqueInstalls as number) >= 0
      ? snapshot.uniqueInstalls
      : null;
    return {
      uniqueInstalls,
      publicUrl: uniqueInstallPublicUrl(snapshot),
      recorded: snapshot.recorded === true,
      unavailable: uniqueInstalls == null,
    };
  } catch {
    return { uniqueInstalls: null, publicUrl: UNIQUE_INSTALLS_PUBLIC_URL, unavailable: true };
  }
}
