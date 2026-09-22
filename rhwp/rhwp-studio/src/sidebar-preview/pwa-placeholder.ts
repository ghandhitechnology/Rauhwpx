/** The desktop integration imports this lazily; previews never install a worker. */
export function registerSW(): () => Promise<void> {
  return async () => {};
}
