import type { CellPathLike } from './types';

/**
 * The complete container address carried by a rendered/selected object.
 *
 * `sec`/`ppi`/`ci` alone identify only a body control.  Container-local
 * controls can reuse those numeric indexes, so callers must keep every
 * address discriminator until they reach an address-aware API.
 */
export interface AddressedObjectRef {
  sec: number;
  ppi: number;
  ci: number;
  type: string;
  cellIdx?: number;
  cellParaIdx?: number;
  outerTableControlIdx?: number;
  cellPath?: CellPathLike;
  headerFooter?: unknown;
  noteRef?: unknown;
  memoRef?: unknown;
}

export type ObjectAddressScope = 'body' | 'cell' | 'header-footer' | 'note' | 'memo';

function hasAddressMarker(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function objectAddressScope(ref: AddressedObjectRef): ObjectAddressScope {
  if (hasAddressMarker(ref.memoRef)) return 'memo';
  if (hasAddressMarker(ref.noteRef)) return 'note';
  if (hasAddressMarker(ref.headerFooter)) return 'header-footer';
  if (
    (Array.isArray(ref.cellPath) && ref.cellPath.length > 0)
    || hasAddressMarker(ref.outerTableControlIdx)
    || hasAddressMarker(ref.cellIdx)
    || hasAddressMarker(ref.cellParaIdx)
  ) return 'cell';
  return 'body';
}

export function isTopLevelBodyObject(ref: AddressedObjectRef): boolean {
  return objectAddressScope(ref) === 'body';
}

/** The native layer-order API supports every top-level floating control kind. */
export function isTopLevelLayerOrderTarget(ref: AddressedObjectRef): boolean {
  return isTopLevelBodyObject(ref) && (
    ref.type === 'shape'
    || ref.type === 'line'
    || ref.type === 'group'
    || ref.type === 'ole'
    || ref.type === 'image'
    || ref.type === 'table'
    || ref.type === 'equation'
  );
}

/** Grouping currently has a body-paragraph API only. */
export function canGroupTopLevelBodyObjects(refs: readonly AddressedObjectRef[]): boolean {
  if (refs.length < 2) return false;
  const section = refs[0].sec;
  return refs.every(ref =>
    ref.sec === section
    && isTopLevelBodyObject(ref)
    && (ref.type === 'shape' || ref.type === 'image'),
  );
}

/** Ungrouping currently has a body-paragraph API only. */
export function canUngroupTopLevelBodyObject(ref: AddressedObjectRef | null | undefined): boolean {
  return !!ref && ref.type === 'group' && isTopLevelBodyObject(ref);
}

function stableAddressPart(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value);
}

function stableCellPath(value: CellPathLike | undefined): string {
  return !Array.isArray(value) || value.length === 0 ? '' : JSON.stringify(value);
}

/**
 * Compare the complete object identity, including its containing document
 * domain.  This prevents a body object and a nested object with coincident
 * numeric indexes from toggling each other out of a multi-selection.
 */
export function sameAddressedObject(a: AddressedObjectRef, b: AddressedObjectRef): boolean {
  return a.sec === b.sec
    && a.ppi === b.ppi
    && a.ci === b.ci
    && a.type === b.type
    && stableCellPath(a.cellPath) === stableCellPath(b.cellPath)
    && stableAddressPart(a.headerFooter) === stableAddressPart(b.headerFooter)
    && stableAddressPart(a.noteRef) === stableAddressPart(b.noteRef)
    && stableAddressPart(a.memoRef) === stableAddressPart(b.memoRef);
}
