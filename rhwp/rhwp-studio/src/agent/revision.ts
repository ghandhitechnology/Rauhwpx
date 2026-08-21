/**
 * 문서 revision 카운터 (MCP 좌표 낙관적 동시성 제어용).
 *
 * 모든 MCP read 툴은 revision을 반환하고, 모든 write 툴은 expectedRevision을
 * 검사한다. 사용자 편집·에이전트 편집 모두 EventBus의 문서 변경 이벤트를
 * 거치므로 여기서 구독해 단조 증가시킨다.
 *
 * 동기 bump + 마이크로태스크 dedupe: 같은 틱의 첫 이벤트가 즉시 rev를 올리고
 * (write 툴이 이벤트 발행 직후 같은 틱에서 새 revision을 읽을 수 있도록),
 * 함께 발행되는 동반 이벤트('document-mutated' + 'document-changed')는
 * 흡수한다.
 *
 * 내용이 변하지 않는 이벤트는 bump 하지 않는다 — 과잉 bump 하나가
 * REVISION_MISMATCH → 재조회 → LLM 왕복 하나를 통째로 낭비시키기 때문이다:
 *  - 저장 계열의 dirty false 전이는 직렬화만 했을 뿐 내용이 같다.
 *  - holdDuring() 은 스냅샷 복원으로 문서가 그대로 돌아오는 검증 창
 *    (verify_changes 미리보기)의 이벤트를 흡수한다.
 */
import type { EventBus } from '../core/event-bus.ts';

const REVISION_EVENTS = ['document-mutated', 'document-changed'] as const;

/**
 * dirty false 전이 중 내용 불변이 보장되는 저장 계열 이유만 bump 를 생략한다.
 * 'document-initialized'(문서 로드/교체)는 반드시 bump 해야 한다 — 로드 경로는
 * document-mutated/changed 를 발행하지 않아 이 전이가 유일한 revision 신호이고,
 * 놓치면 이전 문서에서 든 expectedRevision 이 새 문서에 통과한다. 모르는 이유는
 * 안전하게 bump 한다.
 */
const CLEAN_REASONS_WITHOUT_BUMP = new Set(['save', 'save-as', 'host-save']);

export class RevisionTracker {
  private rev = 1;
  private inWindow = false;
  private held = 0;
  private unsubscribes: Array<() => void> = [];

  constructor(eventBus: EventBus) {
    const bump = () => {
      if (this.held > 0) return;
      if (this.inWindow) return;
      this.rev++;
      this.inWindow = true;
      queueMicrotask(() => {
        this.inWindow = false;
      });
    };
    for (const name of REVISION_EVENTS) {
      this.unsubscribes.push(eventBus.on(name, bump));
    }
    // dirty true 전이는 실제 변이(document-mutated/changed 동반)의 일부지만,
    // 저장에 의한 false 전이는 내용 불변 — 저장 직후의 쓰기가 불필요하게 실패하지
    // 않게 한다. 저장이 아닌 false 전이(문서 로드 등)는 그대로 bump 한다.
    this.unsubscribes.push(eventBus.on('document-dirty-changed', (change) => {
      const c = change as { dirty?: boolean; reason?: string } | undefined;
      if (c?.dirty === false && typeof c.reason === 'string' && CLEAN_REASONS_WITHOUT_BUMP.has(c.reason)) return;
      bump();
    }));
  }

  get revision(): number {
    return this.rev;
  }

  /**
   * fn 실행 동안 bump 를 멈춘다. 문서를 변이 없이 복원하는 것이 보장되는 창
   * (스냅샷 restore 로 끝나는 검증/미리보기)에만 사용할 것 — 실제 변이 창에
   * 쓰면 오래된 expectedRevision 이 통과해 좌표가 어긋난다.
   */
  holdDuring<T>(fn: () => T): T {
    this.held++;
    try {
      return fn();
    } finally {
      this.held--;
    }
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }
}
