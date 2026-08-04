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
 * 흡수한다. autosave/dirty-state 변동으로 인한 과잉 bump는 무해하다
 * (에이전트가 재조회할 뿐) — 문서화된 동작.
 */
import type { EventBus } from '../core/event-bus.ts';

const REVISION_EVENTS = ['document-mutated', 'document-changed', 'document-dirty-changed'] as const;

export class RevisionTracker {
  private rev = 1;
  private inWindow = false;
  private unsubscribes: Array<() => void> = [];

  constructor(eventBus: EventBus) {
    const bump = () => {
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
  }

  get revision(): number {
    return this.rev;
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }
}
