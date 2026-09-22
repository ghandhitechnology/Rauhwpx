// HTTP previews on LAN/Tailscale are not secure contexts, so randomUUID may
// be absent. Install before importing the fixtures and production sidebar.
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

// Reset before importing production modules, which hydrate IndexedDB on import.
const url = new URL(location.href);
if (url.searchParams.get('reset') === '1') {
  localStorage.clear();
  sessionStorage.clear();
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .filter((database) => database.name)
      .map(
        (database) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(database.name!);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
              reject(
                new Error('Close other sidebar preview tabs before resetting.'),
              );
          }),
      ),
  );
  url.searchParams.delete('reset');
  history.replaceState(null, '', url);
}
await import('./main.ts');
export {};
