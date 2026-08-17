/**
 * 연결이 끊긴 동안 저장한 최종 턴 결과를 Studio에 재전송한다.
 * 전송이 실패하면 다음 재연결에서 다시 시도할 수 있도록 결과를 보존한다.
 */
export function replayMissedTurnEnd(record, socket, sendJson) {
  const event = record.missedTurnEnd;
  if (!event) return false;
  if (!sendJson(socket, { v: 1, type: 'agent-event', event })) return false;
  record.missedTurnEnd = null;
  return true;
}
