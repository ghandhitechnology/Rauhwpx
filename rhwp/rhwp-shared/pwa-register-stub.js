// Browser extensions own their background lifecycle and must not install the
// Studio PWA service worker. This module satisfies the shared UI import while
// intentionally leaving registration disabled in extension bundles.
export function registerSW() {
  return async () => {};
}
