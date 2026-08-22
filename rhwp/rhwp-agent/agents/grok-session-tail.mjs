// grok 헤드리스 stdout 은 서브에이전트 귀속이 깨져 있다(parent_tool_use_id 가 전부
// null, 자식 본문이 루트 블록에 붙음 — 1.0.5 라이브 확인). 깨끗한 수명주기는
// 디스크에만 있다: $GROK_HOME/sessions/<percent-encoded cwd>/<sessionId>/updates.jsonl
// 이 JSON-RPC 라인({params:{update:{sessionUpdate: …}}})으로 부모 스트림을,
// 형제 디렉터리 <subagent_id>/updates.jsonl 이 자식 스트림을 담는다.
// 이 모듈은 그 파일들을 폴링으로 꼬리 추적한다. 파일은 턴 중간에도 증분으로
// 쓰이지만 여러 줄이 한 번에 flush 되고(runG 폴링: 스폰 3초 뒤 5줄, 종료 시 4줄)
// 메시지 완성 시점에야 나타날 수 있다 — 배치 도착과 잘린 마지막 줄을 견딘다.
import nodeFs from 'node:fs';
import path from 'node:path';

/** 한 폴에서 위치 지정으로 읽는 최대 바이트 — 라인 하나보다 넉넉히 크다. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * grok 이 sessions 디렉터리 키로 쓰는 cwd 인코딩. realpath 를 percent-encode 한다
 * (라이브 확인: cwd /tmp/... 스폰 → 디렉터리 %2Fprivate%2Ftmp%2F... — macOS 의
 * /tmp 심볼릭 링크가 풀린 형태였다). encodeURIComponent 와 동일한 %2F 스타일.
 *
 * @param {string} cwd
 * @param {{ realpathSync?: typeof nodeFs.realpathSync }} [fs]
 */
export function grokSessionsCwdKey(cwd, fs = nodeFs) {
  let resolved = String(cwd ?? '');
  try {
    resolved = fs.realpathSync?.(resolved) ?? resolved;
  } catch {
    // 아직 없는 디렉터리 등 — 원문 그대로 인코딩하고 탐색 폴백에 맡긴다.
  }
  return encodeURIComponent(resolved);
}

/**
 * 부모/자식 updates.jsonl 꼬리 추적기. fs 와 타이머가 주입 가능해 픽스처 파일로
 * 단위 테스트할 수 있다. 이벤트 필터링(턴 경계, 중복 제거)은 호출자(grok.mjs)의
 * 몫이고, 이 모듈은 새 라인을 순서대로 전달하는 일만 한다.
 *
 * @param {Object} config
 * @param {string} config.grokHome
 * @param {string} config.cwd 스폰 cwd — 세션 디렉터리 키 계산에 쓴다.
 * @param {string} config.sessionId CLI 가 보고한 세션 ID (디렉터리 이름).
 * @param {(scope: {kind:'parent'}|{kind:'child', subagentId:string}, update: any, meta: {timestampMs?: number, eventId?: string}) => void} config.onUpdate
 * @param {number} [config.pollIntervalMs]
 * @param {Object} [deps]
 * @param {Pick<typeof nodeFs, 'readFileSync'|'readdirSync'|'existsSync'> & Partial<Pick<typeof nodeFs, 'statSync'|'openSync'|'readSync'|'closeSync'|'realpathSync'>>} [deps.fs]
 * @param {typeof setTimeout} [deps.setTimer]
 * @param {typeof clearTimeout} [deps.clearTimer]
 */
export function createGrokSessionTail({
  grokHome,
  cwd,
  sessionId,
  onUpdate,
  pollIntervalMs = 400,
}, {
  fs = nodeFs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const sessionsRoot = path.join(String(grokHome), 'sessions');
  const wantSession = String(sessionId);

  /** @type {{ sessionDir: string, cwdDir: string } | null} */
  let resolved = null;
  /** @type {{ path: string, offset: number } | null} */
  let parentFile = null;
  // subagent_id → 파일 상태. 발견 순서가 전달 순서다.
  /** @type {Map<string, { path: string, offset: number }>} */
  const childFiles = new Map();
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** 세션 디렉터리를 찾는다. 1차: 인코딩된 cwd 키 직행, 2차: 전체 탐색 폴백
   * (cwd 정규화가 어긋나거나 대소문자가 다른 경우 — 세션 ID 는 유일하다). */
  function resolveSessionDir() {
    const directCwdDir = path.join(sessionsRoot, grokSessionsCwdKey(cwd, fs));
    const direct = path.join(directCwdDir, wantSession);
    if (fs.existsSync(path.join(direct, 'updates.jsonl'))) {
      return { sessionDir: direct, cwdDir: directCwdDir };
    }
    let entries;
    try {
      entries = fs.readdirSync(sessionsRoot);
    } catch {
      return null;
    }
    const want = wantSession.toLowerCase();
    for (const name of entries) {
      const cwdDir = path.join(sessionsRoot, name);
      let subs;
      try {
        subs = fs.readdirSync(cwdDir); // session_search.sqlite 등 파일이면 던진다 — 건너뛴다.
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (String(sub).toLowerCase() !== want) continue;
        const sessionDir = path.join(cwdDir, String(sub));
        if (fs.existsSync(path.join(sessionDir, 'updates.jsonl'))) return { sessionDir, cwdDir };
      }
    }
    return null;
  }

  /**
   * 오프셋 이후의 새 바이트만 위치 지정으로 읽는다 — 400ms 폴마다 파일 전체를
   * 재독하지 않는다 (codex-rollout-watcher 의 readTailFrom 과 같은 패턴).
   * 저수준 API 가 없는 주입 fs 는 readFileSync 전체 읽기로 폴백한다.
   *
   * @param {{ path: string, offset: number }} state
   * @returns {Buffer | null}
   */
  function readTailChunk(state) {
    if (typeof fs.statSync === 'function' && typeof fs.openSync === 'function'
      && typeof fs.readSync === 'function') {
      let size;
      try {
        size = Number(fs.statSync(state.path)?.size ?? 0);
      } catch {
        return null;
      }
      if (size < state.offset) state.offset = 0; // 파일이 줄었다(재작성) — 처음부터.
      if (size === state.offset) return null;
      const length = Math.min(size - state.offset, MAX_READ_BYTES);
      let fd;
      try {
        fd = fs.openSync(state.path, 'r');
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, state.offset);
        return buf.subarray(0, read);
      } catch {
        return null;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync?.(fd); } catch {}
        }
      }
    }
    let whole;
    try {
      whole = fs.readFileSync(state.path);
    } catch {
      return null;
    }
    const buf = Buffer.isBuffer(whole) ? whole : Buffer.from(String(whole));
    if (buf.length < state.offset) state.offset = 0;
    if (buf.length === state.offset) return null;
    return buf.subarray(state.offset);
  }

  /**
   * 파일의 새 완성 라인들을 파싱해 돌려준다. 바이트 오프셋으로 증분을 읽고,
   * 개행 없는 꼬리(쓰다 만 라인)는 남겨 다음 폴에서 이어 읽는다.
   *
   * @param {{ path: string, offset: number }} state
   */
  function readNewUpdates(state) {
    const chunk = readTailChunk(state);
    if (!chunk) return [];
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) return [];
    const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
    state.offset += lastNewline + 1;
    const updates = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[grok-tail] skipping unparseable line: ${trimmed.slice(0, 200)}\n`);
        continue;
      }
      // method 는 session/update 와 _x.ai/session/update 가 섞여 온다 —
      // params.update.sessionUpdate 만 보면 된다.
      const update = obj?.params?.update;
      if (!update || typeof update !== 'object') continue;
      const rawMeta = obj?.params?._meta ?? {};
      const stamped = Number(rawMeta.agentTimestampMs);
      const fallback = Number(obj?.timestamp) * 1000;
      const meta = {
        ...(Number.isFinite(stamped) ? { timestampMs: stamped }
          : (Number.isFinite(fallback) && fallback > 0 ? { timestampMs: fallback } : {})),
        ...(rawMeta.eventId ? { eventId: String(rawMeta.eventId) } : {}),
      };
      updates.push({ update, meta });
    }
    return updates;
  }

  /** @param {{kind:'parent'}|{kind:'child', subagentId:string}} scope */
  function deliver(scope, update, meta) {
    try {
      onUpdate(scope, update, meta);
    } catch (e) {
      process.stderr.write(`[grok-tail] onUpdate handler error: ${e?.stack ?? e}\n`);
    }
  }

  function watchChild(subagentId) {
    if (!resolved || !subagentId || childFiles.has(subagentId)) return;
    childFiles.set(subagentId, {
      path: path.join(resolved.cwdDir, subagentId, 'updates.jsonl'),
      offset: 0,
    });
  }

  /** 자식 파일을 지금 EOF 까지 비운다. */
  function drainChild(subagentId) {
    const state = childFiles.get(subagentId);
    if (!state) return;
    for (const { update, meta } of readNewUpdates(state)) {
      deliver({ kind: 'child', subagentId }, update, meta);
    }
  }

  /** 한 바퀴 동기 읽기 — 폴링 틱과 프로세스 종료 직전의 마지막 수확이 함께 쓴다. */
  function drain() {
    if (!resolved) {
      resolved = resolveSessionDir();
      if (!resolved) return;
      parentFile = { path: path.join(resolved.sessionDir, 'updates.jsonl'), offset: 0 };
    }
    // 부모를 먼저 비운다 — subagent_spawned 가 자식 추적과 taskId 매핑을 만들고
    // 나서야 자식 라인이 귀속될 수 있다.
    const currentParentFile = parentFile;
    if (!currentParentFile) return;
    for (const { update, meta } of readNewUpdates(currentParentFile)) {
      const subagentId = update.subagent_id ? String(update.subagent_id) : '';
      if (update.sessionUpdate === 'subagent_spawned' && subagentId) {
        watchChild(subagentId);
      }
      if (update.sessionUpdate === 'subagent_finished' && subagentId) {
        // task 종결을 전달하기 전에 그 자식의 파일을 EOF 까지 비운다 — 스튜디오는
        // 끝난 task 로 오는 본문을 버리므로 자식 대화가 카드 닫힘보다 앞서야 한다.
        watchChild(subagentId);
        drainChild(subagentId);
      }
      deliver({ kind: 'parent' }, update, meta);
    }
    for (const subagentId of childFiles.keys()) {
      drainChild(subagentId);
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      try {
        drain();
      } catch (e) {
        process.stderr.write(`[grok-tail] drain error: ${e?.stack ?? e}\n`);
      }
      schedule();
    }, pollIntervalMs);
    timer?.unref?.();
  }

  return {
    start() {
      if (stopped || timer) return;
      schedule();
    },
    drain,
    stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
