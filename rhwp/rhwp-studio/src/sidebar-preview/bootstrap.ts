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
