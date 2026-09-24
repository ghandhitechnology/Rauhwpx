/** Keeps the editor's command groups on one row and moves the trailing groups into More. */
export class EditorToolbarOverflow {
  private readonly groups: Array<{ group: HTMLElement; separator: HTMLElement | null; anchor: Comment }>;
  private readonly more: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly mutationObserver: MutationObserver;
  private lastWidth = -1;
  private lastMode = '';
  private lastCollapsed = false;

  constructor(private readonly toolbar: HTMLElement) {
    const children = Array.from(toolbar.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
    this.groups = children.filter(node => node.classList.contains('tb-group')).map((group) => {
      const previous = group.previousElementSibling;
      const separator = previous instanceof HTMLElement && previous.classList.contains('tb-sep') ? previous : null;
      const anchor = document.createComment('toolbar group');
      toolbar.insertBefore(anchor, separator ?? group);
      return { group, separator, anchor };
    });

    this.more = document.createElement('button');
    this.more.id = 'editor-toolbar-more';
    this.more.type = 'button';
    this.more.className = 'tb-btn tb-lg';
    this.more.title = '더 보기';
    this.more.setAttribute('aria-label', '더 보기');
    this.more.setAttribute('aria-haspopup', 'dialog');
    this.more.setAttribute('aria-expanded', 'false');
    this.more.setAttribute('aria-controls', 'editor-toolbar-overflow');
    this.more.innerHTML = '<svg class="tb-ico" aria-hidden="true"><use href="#ri-lg-more"/></svg><span class="tb-label">더 보기</span>';
    this.more.hidden = true;

    this.popover = document.createElement('div');
    this.popover.id = 'editor-toolbar-overflow';
    this.popover.className = 'tb-overflow-popover';
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', '더 보기');
    this.popover.hidden = true;
    this.content = document.createElement('div');
    this.content.className = 'tb-overflow-content';
    this.popover.append(this.content);
    toolbar.append(this.more, this.popover);

    this.more.addEventListener('click', (event) => {
      if (this.popover.hidden) {
        this.open(event.detail === 0);
      } else {
        this.close(true);
      }
    });
    this.toolbar.addEventListener('mousedown', this.onToolbarMouseDown);
    this.toolbar.addEventListener('keydown', this.onToolbarKeyDown);
    this.toolbar.addEventListener('focusout', this.onToolbarFocusOut);
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.toolbar.clientWidth;
      if (width !== this.lastWidth) this.refresh();
    });
    this.resizeObserver.observe(toolbar);
    this.lastCollapsed = toolbar.classList.contains('collapsed');
    this.mutationObserver = new MutationObserver((records) => {
      const collapsed = toolbar.classList.contains('collapsed');
      // 사이드바 토글처럼 나중에 붙는 고정 요소도 폭 계산에 넣는다.
      const pinnedAdded = records.some(record => Array.from(record.addedNodes).some(node =>
        node instanceof HTMLElement && node !== this.more && node !== this.popover
        && !node.classList.contains('tb-group') && !node.classList.contains('tb-sep')));
      if (pinnedAdded || collapsed !== this.lastCollapsed
        || (toolbar.dataset.contextMode ?? 'default') !== this.lastMode) {
        this.refresh();
      }
    });
    this.mutationObserver.observe(toolbar, {
      attributes: true, attributeFilter: ['class', 'data-context-mode'], childList: true,
    });
    window.addEventListener('resize', this.onWindowResize);
    this.refresh();
  }

  refresh(): void {
    const width = this.toolbar.clientWidth;
    this.lastCollapsed = this.toolbar.classList.contains('collapsed');
    if (!width || this.lastCollapsed) {
      this.close(false);
      return;
    }
    this.lastWidth = width;
    const mode = this.toolbar.dataset.contextMode ?? 'default';
    const wasOpen = !this.popover.hidden && mode === this.lastMode;
    this.lastMode = mode;
    const focused = this.toolbar.contains(document.activeElement)
      ? document.activeElement as HTMLElement : null;
    this.toolbar.style.visibility = 'hidden';
    this.restoreGroups();
    this.more.hidden = false;
    const style = getComputedStyle(this.toolbar);
    const gap = parseFloat(style.columnGap) || 0;
    const outerWidth = (element: HTMLElement): number => {
      const computed = getComputedStyle(element);
      if (computed.display === 'none') return 0;
      return element.getBoundingClientRect().width
        + (parseFloat(computed.marginLeft) || 0) + (parseFloat(computed.marginRight) || 0);
    };
    const moreWidth = outerWidth(this.more);
    const pinnedWidth = Array.from(this.toolbar.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .filter(child => child !== this.more && child !== this.popover
        && !child.classList.contains('tb-group') && !child.classList.contains('tb-sep'))
      .reduce((sum, child) => sum + outerWidth(child), 0);
    const available = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - pinnedWidth - gap * (this.groups.length + 2);
    const active = this.groups.filter(({ group }) => getComputedStyle(group).display !== 'none');
    const size = (entry: typeof active[number], first: boolean): number =>
      outerWidth(entry.group)
        + (!first && entry.separator && getComputedStyle(entry.separator).display !== 'none'
          ? outerWidth(entry.separator) : 0);
    const total = active.reduce((sum, entry, index) => sum + size(entry, index === 0), 0);
    const limit = total <= available ? available : available - moreWidth;
    let used = 0;
    let overflowing = false;
    for (const [index, entry] of active.entries()) {
      const next = size(entry, index === 0);
      if (overflowing || used + next > limit) {
        overflowing = true;
        if (entry.separator) this.content.append(entry.separator);
        this.content.append(entry.group);
      } else {
        used += next;
      }
    }
    this.more.hidden = !overflowing;
    this.toolbar.toggleAttribute('data-toolbar-overflow', overflowing);
    if (!overflowing || !wasOpen) this.close(false);
    else this.open(false);
    this.toolbar.style.visibility = '';
    if (focused && (document.activeElement !== focused || focused.getClientRects().length === 0)) {
      if (focused.isConnected && focused.getClientRects().length > 0) focused.focus({ preventScroll: true });
      else if (!this.more.hidden) this.more.focus({ preventScroll: true });
      else Array.from(this.toolbar.querySelectorAll<HTMLButtonElement>('.tb-group .tb-btn:not(:disabled)'))
        .find(button => button.getClientRects().length > 0)?.focus({ preventScroll: true });
    }
  }

  closePopover(): void {
    this.close(false);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.toolbar.removeEventListener('mousedown', this.onToolbarMouseDown);
    this.toolbar.removeEventListener('keydown', this.onToolbarKeyDown);
    this.toolbar.removeEventListener('focusout', this.onToolbarFocusOut);
    this.restoreGroups();
    this.more.remove();
    this.popover.remove();
  }

  private restoreGroups(): void {
    for (const { group, separator, anchor } of this.groups) {
      anchor.after(...(separator ? [separator, group] : [group]));
    }
  }

  private open(focusFirst: boolean): void {
    if (this.more.hidden) return;
    this.popover.hidden = false;
    this.more.setAttribute('aria-expanded', 'true');
    this.toolbar.classList.add('tb-overflow-open');
    const anchor = this.more.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - this.popover.offsetWidth - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - this.popover.offsetHeight - 8));
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
    if (focusFirst) {
      this.content.querySelector<HTMLButtonElement>('.tb-btn:not(:disabled)')?.focus();
    }
  }

  private close(restoreFocus: boolean): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.more.setAttribute('aria-expanded', 'false');
    this.toolbar.classList.remove('tb-overflow-open');
    if (restoreFocus) this.more.focus();
  }

  private readonly onWindowResize = (): void => this.refresh();
  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.popover.hidden && !this.popover.contains(event.target as Node)
      && !this.more.contains(event.target as Node)) this.close(false);
  };
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.popover.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const split = this.popover.querySelector<HTMLElement>('.tb-split.open');
    if (split) {
      split.classList.remove('open');
      split.querySelector<HTMLButtonElement>('.tb-split-arrow')?.focus();
      return;
    }
    this.close(true);
  };
  private readonly onToolbarMouseDown = (event: MouseEvent): void => {
    if (!this.popover.hidden && (event.target as Element).closest('.tb-overflow-content .tb-btn[data-cmd]')) {
      this.close(this.popover.contains(document.activeElement));
    }
  };
  private readonly onToolbarKeyDown = (event: KeyboardEvent): void => {
    if (!this.popover.hidden && (event.key === 'Enter' || event.key === ' ')
      && (event.target as Element).closest('.tb-overflow-content .tb-btn[data-cmd]')) {
      this.close(this.popover.contains(document.activeElement));
    }
  };
  private readonly onToolbarFocusOut = (event: FocusEvent): void => {
    if (this.popover.hidden) return;
    const next = event.relatedTarget;
    if (next instanceof Node && (this.popover.contains(next) || this.more.contains(next))) return;
    this.close(false);
  };
}
