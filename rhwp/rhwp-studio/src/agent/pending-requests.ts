/**
 * requestId 로 짝을 맞추는 요청/응답 대기표.
 *
 * 허브 응답은 언제든 오지 않을 수 있으므로(허브 재시작·CLI 실패) 모든
 * 대기는 타임아웃을 갖고 null 로 안착한다 — 던지지 않는다. 사이드바가
 * `await` 한 값이 null 이면 "지금은 알 수 없다"는 뜻이다.
 *
 * bridge.ts 는 WebSocket·DOM 에 묶여 있어 Node 테스트에서 인스턴스화할 수
 * 없으므로, 짝 맞추기 규칙만 이 모듈로 떼어 직접 검증한다.
 */
export class PendingRequestRegistry {
  private entries = new Map<
    string,
    { settle: (value: unknown) => void; timer: ReturnType<typeof setTimeout> | null }
  >();

  /** 대기 중인 요청 수 (테스트·누수 확인용). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * requestId 하나를 대기표에 올린다. timeoutMs 안에 settle 되지 않으면
   * null 로 안착한다. 같은 requestId 가 이미 있으면 앞의 대기는 null 로 닫는다.
   */
  create<T>(requestId: string, timeoutMs: number): Promise<T | null> {
    this.settle(requestId, null);
    return new Promise<T | null>((resolve) => {
      const entry = {
        settle: (value: unknown) => resolve(value as T | null),
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.entries.delete(requestId);
          resolve(null);
        }, timeoutMs);
      }
      this.entries.set(requestId, entry);
    });
  }

  /** 대기 중이면 값으로 안착시키고 true. 모르는 requestId 면 false. */
  settle(requestId: string, value: unknown): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.entries.delete(requestId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.settle(value);
    return true;
  }

  /** 연결이 끊기거나 dispose 될 때 — 모든 대기를 null 로 닫는다. */
  cancelAll(): void {
    const pending = [...this.entries.values()];
    this.entries.clear();
    for (const entry of pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle(null);
    }
  }
}
