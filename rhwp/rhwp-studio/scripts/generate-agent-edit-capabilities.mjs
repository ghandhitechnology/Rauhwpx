import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = resolve(root, 'src/core/wasm-bridge.ts');
const registryPath = resolve(root, 'src/core/mutation-method-registry.ts');
const typesPath = resolve(root, 'src/core/types.ts');
const outputPath = resolve(root, 'src/agent/engine-edit-capabilities.generated.ts');

const [bridgeSource, registrySource, typesSource] = await Promise.all([
  readFile(bridgePath, 'utf8'),
  readFile(registryPath, 'utf8'),
  readFile(typesPath, 'utf8'),
]);
function registryMethods(name) {
  const match = registrySource.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`Could not parse ${name}`);
  return [...match[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((entry) => entry[1]);
}
const mutationMethods = registryMethods('MUTATING_METHODS');
const sessionMethods = registryMethods('AGENT_EDIT_SESSION_METHODS');
const methodKinds = new Map([
  ...mutationMethods.map((method) => [method, 'document']),
  ...sessionMethods.map((method) => [method, 'session']),
]);
const methods = [...mutationMethods, ...sessionMethods];

function matchingParen(source, openIndex) {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  throw new Error(`Unclosed method parameter list at ${openIndex}`);
}

function topLevelParameters(source) {
  const parts = [];
  let start = 0;
  let quote = '';
  const depth = { '(': 0, '[': 0, '{': 0, '<': 0 };
  const close = { ')': '(', ']': '[', '}': '{', '>': '<' };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char in depth) depth[char] += 1;
    else if (char in close) depth[close[char]] -= 1;
    else if (char === ',' && Object.values(depth).every((value) => value === 0)) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (source.slice(start).trim()) parts.push(source.slice(start));
  return parts;
}

const capabilities = methods.map((method) => {
  const match = new RegExp(`^ {2}(?:async )?${method}\\s*\\(`, 'm').exec(bridgeSource);
  if (!match) throw new Error(`Missing WasmBridge signature: ${method}`);
  const openIndex = bridgeSource.indexOf('(', match.index);
  const closeIndex = matchingParen(bridgeSource, openIndex);
  const parameterSource = bridgeSource.slice(openIndex + 1, closeIndex);
  const cleanParameterSource = parameterSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const parameters = topLevelParameters(cleanParameterSource).map((parameter) => {
    const normalized = parameter.trim().replace(/^\.\.\./, '');
    const name = normalized.match(/^([A-Za-z_$][\w$]*)\s*[?:=]/)?.[1];
    if (!name) throw new Error(`Could not parse ${method} parameter: ${normalized}`);
    return name;
  });
  const signature = `${method}(${cleanParameterSource.replace(/\s+/g, ' ').trim()})`;
  return { method, kind: methodKinds.get(method), parameters, signature };
}).sort((a, b) => a.method.localeCompare(b.method));

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return index;
  }
  throw new Error(`Unclosed type body at ${openIndex}`);
}

function typeDefinition(name) {
  for (const source of [typesSource, bridgeSource]) {
    const match = new RegExp(`(?:export\\s+)?(interface|type)\\s+${name}\\b`).exec(source);
    if (!match) continue;
    if (match[1] === 'interface') {
      const open = source.indexOf('{', match.index);
      return source.slice(match.index, matchingBrace(source, open) + 1)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const start = match.index;
    const semicolon = source.indexOf(';', match.index);
    if (semicolon >= 0) {
      return source.slice(start, semicolon + 1)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return null;
}

const ignoredTypes = new Set([
  'Array', 'Boolean', 'Date', 'Map', 'Number', 'Object', 'Partial', 'Promise',
  'ReadonlyArray', 'Record', 'Set', 'String', 'Uint8Array',
]);
const extraTypeSeeds = [
  'CharProperties', 'ParaProperties', 'ShapeProperties', 'PictureProperties', 'EquationProperties',
];
const pendingTypes = [...new Set([
  ...extraTypeSeeds,
  ...capabilities.flatMap(({ signature }) =>
    [...signature.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((match) => match[0])),
])];
const typeDefinitions = {};
while (pendingTypes.length > 0) {
  const name = pendingTypes.shift();
  if (!name || ignoredTypes.has(name) || name in typeDefinitions) continue;
  const definition = typeDefinition(name);
  if (!definition) continue;
  typeDefinitions[name] = definition;
  for (const match of definition.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    if (!ignoredTypes.has(match[0]) && !(match[0] in typeDefinitions)) pendingTypes.push(match[0]);
  }
}

const output = `/** Generated by scripts/generate-agent-edit-capabilities.mjs. Do not edit manually. */\n` +
  `export const ENGINE_EDIT_CAPABILITIES = ${JSON.stringify(capabilities, null, 2)} as const;\n` +
  `export const ENGINE_EDIT_TYPE_DEFINITIONS = ${JSON.stringify(typeDefinitions, null, 2)} as const;\n`;
await writeFile(outputPath, output);
console.log(`Generated ${capabilities.length} agent engine-edit capabilities.`);
