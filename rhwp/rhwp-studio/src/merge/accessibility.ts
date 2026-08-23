import type { MergePreviewRole } from './domain.ts';

export interface PreviewTabElement {
  dataset: { role?: string };
  tabIndex: number;
  setAttribute(name: string, value: string): void;
}

export function syncPreviewTabState(
  tabs: Iterable<PreviewTabElement>,
  activeRole: MergePreviewRole,
): void {
  for (const tab of tabs) {
    const selected = tab.dataset.role === activeRole;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

export function adjacentPreviewRole(
  roles: readonly MergePreviewRole[],
  current: MergePreviewRole,
  key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): MergePreviewRole {
  const currentIndex = Math.max(0, roles.indexOf(current));
  const nextIndex = key === 'Home'
    ? 0
    : key === 'End'
      ? roles.length - 1
      : (currentIndex + (key === 'ArrowRight' ? 1 : -1) + roles.length) % roles.length;
  return roles[nextIndex];
}

export function wrappedFocusIndex(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount <= 0) return null;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return null;
}

