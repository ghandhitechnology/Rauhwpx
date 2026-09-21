import test from 'node:test';
import { checkProviderSurface } from './check-provider-surface.mjs';

test('implementation roots contain only the supported Claude, Codex, and Pi providers', () => {
  checkProviderSurface();
});
