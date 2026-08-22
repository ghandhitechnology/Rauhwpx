import type { WasmBridge } from '../core/wasm-bridge.ts';
import {
  AGENT_EDIT_SESSION_METHODS,
  MUTATING_METHODS,
} from '../core/mutation-method-registry.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import {
  ENGINE_EDIT_CAPABILITIES,
  ENGINE_EDIT_TYPE_DEFINITIONS,
} from './engine-edit-capabilities.generated.ts';
import { AgentToolError } from './types.ts';

const DOCUMENT_EDIT_METHODS = new Set<string>(MUTATING_METHODS);
const SESSION_EDIT_METHODS = new Set<string>(AGENT_EDIT_SESSION_METHODS);
const MAX_ENGINE_EDIT_OPERATIONS = 32;
const MAX_ENGINE_EDIT_ARGUMENT_BYTES = 8 * 1024 * 1024;

export interface EngineEditOperation {
  method: string;
  args: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bytesFromBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new AgentToolError('INVALID_ARGS', 'Invalid $base64 engine argument');
  }
}

/** Decode JSON-safe MCP arguments, including bounded binary values. */
function decodeArgument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeArgument);
  const record = asRecord(value);
  if (!record) return value;
  if (typeof record['$base64'] === 'string' && Object.keys(record).length === 1) {
    return bytesFromBase64(record['$base64']);
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decodeArgument(child)]));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return { $base64: bytesToBase64(value), byteLength: value.byteLength };
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function serializeEngineResult(value: unknown) {
  if (typeof value !== 'string') return jsonSafe(value);
  let parsedJson: unknown = null;
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { parsedJson = jsonSafe(JSON.parse(trimmed)); } catch { /* preserve non-JSON text */ }
  }
  return { value, parsedJson };
}

function failureMessage(result: unknown): string | null {
  if (result === false) return 'engine returned false';
  if (typeof result === 'number' && result < 0) return `engine returned ${result}`;
  const record = asRecord(result);
  if (record?.['ok'] === false) {
    return typeof record['error'] === 'string' ? record['error'] : 'engine returned ok:false';
  }
  if (typeof result === 'string' && result.trimStart().startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(result));
      if (parsed?.['ok'] === false) {
        return typeof parsed['error'] === 'string' ? parsed['error'] : 'engine returned ok:false';
      }
    } catch { /* non-JSON engine result */ }
  }
  return null;
}

function invokeEngineMethod(
  wasm: WasmBridge,
  operation: EngineEditOperation,
  allowedMethods: ReadonlySet<string>,
): unknown {
  if (!allowedMethods.has(operation.method)) {
    throw new AgentToolError(
      'ENGINE_EDIT_NOT_ALLOWED',
      `Engine method '${operation.method}' is not allowed for this edit mode. Call get_engine_edit_capabilities first.`,
    );
  }
  const method = Reflect.get(wasm, operation.method);
  if (typeof method !== 'function') {
    throw new AgentToolError('ENGINE_EDIT_UNAVAILABLE', `Engine method '${operation.method}' is unavailable in this build.`);
  }
  if (typeof wasm.hasDocumentMethod === 'function' && !wasm.hasDocumentMethod(operation.method)) {
    throw new AgentToolError(
      'ENGINE_EDIT_UNAVAILABLE',
      `Engine method '${operation.method}' is registered in Studio but missing from the loaded WASM document. Rebuild with wasm-pack build --target web.`,
    );
  }
  const result = Reflect.apply(method, wasm, operation.args.map(decodeArgument));
  const failure = failureMessage(result);
  if (failure) throw new AgentToolError('ENGINE_EDIT_FAILED', `${operation.method}: ${failure}`);
  return serializeEngineResult(result);
}

const PROPERTY_ARGUMENT_TYPES: Readonly<Record<string, string>> = {
  setShapeProperties: 'Partial<ShapeProperties>',
  setCellShapePropertiesByPath: 'Partial<ShapeProperties>',
  setPictureProperties: 'Partial<PictureProperties>',
  setHeaderFooterPictureProperties: 'Partial<PictureProperties>',
  setCellPicturePropertiesByPath: 'Partial<PictureProperties>',
  setEquationProperties: 'Partial<EquationProperties>',
  setNoteEquationProperties: 'Partial<EquationProperties>',
};

function argumentGuide(method: string, signature: string) {
  const guide: Record<string, string> = {};
  if (signature.includes('pathJson: string')) {
    guide.pathJson = 'JSON.stringify(CellPathEntry[]) using typeDefinitions.CellPathEntry';
  }
  if (signature.includes('cellPathJson: string')) {
    guide.cellPathJson = 'JSON.stringify(CellPathEntry[]) using typeDefinitions.CellPathEntry';
  }
  if (signature.includes('propsJson: string')) {
    guide.propsJson = method.includes('CharFormat')
      ? 'JSON.stringify(Partial<CharProperties>) using typeDefinitions.CharProperties'
      : 'JSON.stringify(Partial<ParaProperties>) using typeDefinitions.ParaProperties';
  }
  const propertyType = PROPERTY_ARGUMENT_TYPES[method];
  if (propertyType) guide.props = `${propertyType} using the matching typeDefinitions entry`;
  switch (method) {
    case 'createShapeControl':
      guide.params = '{sectionIdx, paraIdx, charOffset, width?, height?, horzOffset?, vertOffset?, shapeType?:"line"|"rectangle"|"ellipse"|"polygon"|"arc"|"connector-straight"|"connector-stroke"|"connector-arc"|"connector-straight-arrow"|"connector-stroke-arrow"|"connector-arc-arrow"|"textbox", treatAsChar?, textWrap?, lineFlipX?, lineFlipY?, polygonPoints?:Array<{x:number,y:number}>}';
      break;
    case 'createNumbering':
      guide.json = 'JSON.stringify({levelFormats:string[7], numberFormats?:number[7], startNumber?:number})';
      break;
    case 'createStyle':
      guide.json = 'JSON.stringify({name, englishName?, type?, nextStyleId?, baseCharShapeId?, baseParaShapeId?})';
      break;
    case 'updateStyle':
      guide.json = 'JSON.stringify({name?, englishName?, nextStyleId?})';
      break;
    case 'updateStyleShapes':
      guide.charModsJson = 'JSON.stringify(Partial<CharProperties>)';
      guide.paraModsJson = 'JSON.stringify(Partial<ParaProperties>)';
      break;
    case 'setFormValue':
    case 'setFormValueInCell':
      guide.valueJson = 'JSON.stringify({value:0|1}) for checkbox/radio, or JSON.stringify({text:string}) for combo/edit controls';
      break;
  }
  return guide;
}

export function getEngineEditCapabilities(query = '') {
  const normalized = query.trim().toLowerCase();
  return ENGINE_EDIT_CAPABILITIES
    .filter((capability) => !normalized
      || capability.method.toLowerCase().includes(normalized)
      || capability.signature.toLowerCase().includes(normalized))
    .map((capability) => ({
      ...capability,
      argumentGuide: argumentGuide(capability.method, capability.signature),
    }));
}

export function getEngineEditCapabilityCount() {
  return ENGINE_EDIT_CAPABILITIES.length;
}

export function getEngineEditTypeDefinitions() {
  return ENGINE_EDIT_TYPE_DEFINITIONS;
}

export function applyEngineEdits(
  inputHandler: InputHandler,
  operations: EngineEditOperation[],
): unknown[] {
  if (operations.length === 0 || operations.length > MAX_ENGINE_EDIT_OPERATIONS) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `operations must contain 1..${MAX_ENGINE_EDIT_OPERATIONS} edits`,
    );
  }
  operations.forEach((operation, index) => {
    if (!operation || typeof operation.method !== 'string' || !Array.isArray(operation.args)) {
      throw new AgentToolError('INVALID_ARGS', `operations[${index}] requires method and args[]`);
    }
  });
  const argumentBytes = new TextEncoder().encode(JSON.stringify(operations)).byteLength;
  if (argumentBytes > MAX_ENGINE_EDIT_ARGUMENT_BYTES) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `serialized operations exceed ${MAX_ENGINE_EDIT_ARGUMENT_BYTES} bytes; split the batch`,
    );
  }

  return inputHandler.executeAppliedSnapshot('agent:apply_engine_edits', (wasm) =>
    operations.map((operation) => invokeEngineMethod(wasm, operation, DOCUMENT_EDIT_METHODS)));
}

export function applyEngineEditSession(wasm: WasmBridge, operation: EngineEditOperation) {
  return invokeEngineMethod(wasm, operation, SESSION_EDIT_METHODS);
}
