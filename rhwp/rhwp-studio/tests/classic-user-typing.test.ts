import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const caretRenderer = readFileSync(
  new URL('../src/engine/caret-renderer.ts', import.meta.url),
  'utf8',
);
const editorCss = readFileSync(
  new URL('../src/styles/editor.css', import.meta.url),
  'utf8',
);
const agentTypewriter = readFileSync(
  new URL('../src/agent/typewriter-reveal.ts', import.meta.url),
  'utf8',
);

test('user caret moves immediately without smooth interpolation', () => {
  assert.doesNotMatch(caretRenderer, /is-gliding|glideDuration|transitionDuration/);
  assert.doesNotMatch(editorCss, /\.caret\.is-gliding/);
  assert.match(caretRenderer, /style\.transform = `translate3d\(/);
});

test('user caret uses a classical hard blink', () => {
  assert.match(editorCss, /animation:\s*caret-blink 1s step-end infinite/);
  assert.match(editorCss, /@keyframes caret-blink/);
  assert.doesNotMatch(editorCss, /caret-pulse|\.caret\.is-blinking[^}]*ease-in-out/s);
});

test('agent edits retain their separate typewriter reveal', () => {
  assert.match(agentTypewriter, /export class AgentTypewriterReveal/);
  assert.match(agentTypewriter, /ag-typewriter-caret/);
});
