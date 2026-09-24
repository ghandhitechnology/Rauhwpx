/** Keeps the formatting fields compact while preserving each command's original listener. */
export class EditorStyleOverflow {
  private readonly bands: Array<{ element: HTMLElement; anchor: Comment }>;
  private readonly more: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private lastWidth = -1;

  constructor(private readonly bar: HTMLElement) {
    this.bands = Array.from(bar.querySelectorAll<HTMLElement>(':scope > .sb-command-band')).map(element => {
      const anchor = document.createComment('format band');
      bar.insertBefore(anchor, element);
      return { element, anchor };
    });
    this.more = document.createElement('button');
    this.more.id = 'style-bar-more';
    this.more.type = 'button';
    this.more.title = '서식 더 보기';
    this.more.setAttribute('aria-label', '서식 더 보기');
    this.more.setAttribute('aria-haspopup', 'dialog');
    this.more.setAttribute('aria-expanded', 'false');
    this.more.setAttribute('aria-controls', 'style-bar-overflow');
    this.more.innerHTML = '<span aria-hidden="true">⋯</span><span class="sb-more-label">더 보기</span>';
    this.more.hidden = true;
    this.popover = document.createElement('div');
    this.popover.id = 'style-bar-overflow';
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', '서식 더 보기');
    this.popover.hidden = true;
    this.content = document.createElement('div');
    this.popover.append(this.content);
    bar.querySelector('.sb-collapse-btn')?.before(this.more);
    bar.append(this.popover);

    this.more.addEventListener('click', () => this.popover.hidden ? this.open() : this.close(true));
    this.popover.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('.sb-btn');
      if (button && !button.classList.contains('sb-has-arrow')) this.close(false);
    });
    this.bar.addEventListener('focusout', this.onFocusOut);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.observer = new ResizeObserver(() => {
      if (bar.clientWidth !== this.lastWidth) this.refresh();
    });
    this.observer.observe(bar);
    window.addEventListener('resize', this.onResize);
    this.refresh();
  }

  refresh(): void {
    const width = this.bar.clientWidth;
    if (!width) return;
    this.lastWidth = width;
    const focused = this.bar.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const wasOpen = !this.popover.hidden;
    this.bar.style.visibility = 'hidden';
    this.restore();
    this.bar.removeAttribute('data-style-compact');
    this.bar.toggleAttribute('data-style-condensed', width < 700);
    this.more.hidden = false;
    const field = this.bar.querySelector<HTMLElement>('.sb-field-ribbon-group')!;
    const collapse = this.bar.querySelector<HTMLElement>('.sb-collapse-btn')!;
    const style = getComputedStyle(this.bar);
    const outer = (element: HTMLElement): number => {
      const css = getComputedStyle(element);
      return element.getBoundingClientRect().width
        + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
    };
    const available = width - (parseFloat(style.paddingLeft) || 0)
      - (parseFloat(style.paddingRight) || 0);
    const compact = outer(field) + outer(this.more) + outer(collapse) > available;
    if (compact) {
      this.bar.setAttribute('data-style-compact', '');
      this.bands.forEach(({ element }) => this.content.append(element));
    } else {
      const bandWidths = this.bands.map(({ element }) => outer(element));
      const total = outer(field) + outer(collapse) + bandWidths.reduce((a, b) => a + b, 0);
      const limit = available - (total > available ? outer(this.more) : 0);
      let used = outer(field) + outer(collapse);
      let overflow = false;
      this.bands.forEach(({ element }, i) => {
        if (overflow || used + bandWidths[i] > limit) {
          overflow = true;
          this.content.append(element);
        } else used += bandWidths[i];
      });
    }
    this.more.hidden = this.content.childElementCount === 0;
    if (this.more.hidden || !wasOpen) this.close(false);
    else this.open();
    this.bar.style.visibility = '';
    if (focused && document.activeElement !== focused) {
      if (focused.getClientRects().length && !this.popover.hidden) focused.focus({ preventScroll: true });
      else if (!this.more.hidden) this.more.focus({ preventScroll: true });
    }
  }

  private restore(): void {
    this.bands.forEach(({ element, anchor }) => anchor.after(element));
  }

  private open(): void {
    if (this.more.hidden) return;
    this.popover.hidden = false;
    this.more.setAttribute('aria-expanded', 'true');
    this.bar.classList.add('sb-overflow-open');
    const anchor = this.more.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - this.popover.offsetWidth - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 4, innerHeight - this.popover.offsetHeight - 8));
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private close(focusMore: boolean): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.more.setAttribute('aria-expanded', 'false');
    this.bar.classList.remove('sb-overflow-open');
    if (focusMore) this.more.focus({ preventScroll: true });
  }

  private readonly onResize = (): void => this.refresh();
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.popover.hidden && !this.popover.contains(event.target as Node)
      && !this.more.contains(event.target as Node)) this.close(false);
  };
  private readonly onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (!this.popover.hidden && next instanceof Node
      && !this.popover.contains(next) && !this.more.contains(next)) this.close(false);
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.popover.hidden) return;
    const dropdown = this.popover.querySelector<HTMLElement>('.sb-dropdown.open');
    if (dropdown) { dropdown.classList.remove('open'); return; }
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };
}
