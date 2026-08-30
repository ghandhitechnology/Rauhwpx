export interface AuthorityTransitionHandle {
  release(): void;
}

export interface AuthorityProfileContext {
  profileEpoch: number;
  serverIdentity: string;
}

export interface PendingTakeoverAuthority<TPayload, TBinding> {
  transition: AuthorityTransitionHandle;
  context: AuthorityProfileContext;
  payload: TPayload | null;
  binding: TBinding | null;
  completed: boolean;
}

export interface PendingResultAuthority<TResolution> {
  transition: AuthorityTransitionHandle;
  context: AuthorityProfileContext;
  resolution: TResolution | null;
}

function profileChangedError(): Error {
  return Object.assign(
    new Error('권한 전환 중 Cloud 프로필이 변경되었습니다. 원래 서버로 다시 연결한 뒤 재시도해 주세요.'),
    { code: 'AUTHORITY_PROFILE_CHANGED' },
  );
}

function resumeContext(
  origin: AuthorityProfileContext,
  current: AuthorityProfileContext,
): AuthorityProfileContext {
  if (origin.profileEpoch === current.profileEpoch) return origin;
  if (origin.serverIdentity !== current.serverIdentity) throw profileChangedError();
  return current;
}

function assertContext(expected: AuthorityProfileContext, current: AuthorityProfileContext): void {
  if (expected.profileEpoch !== current.profileEpoch
    || expected.serverIdentity !== current.serverIdentity) throw profileChangedError();
}

export async function runTakeoverAuthorityTransition<TPayload, TBinding>({
  acquire,
  prepare,
  request,
  apply,
  complete,
  refresh,
  settle,
  pending = null,
  onPendingChange,
  context,
}: {
  acquire(): AuthorityTransitionHandle;
  prepare(): Promise<boolean>;
  request(): Promise<TPayload>;
  apply(payload: TPayload): Promise<TBinding>;
  complete(): Promise<void>;
  refresh(): Promise<void>;
  settle(binding: TBinding | null, completed: boolean): void | Promise<void>;
  pending?: PendingTakeoverAuthority<TPayload, TBinding> | null;
  onPendingChange(pending: PendingTakeoverAuthority<TPayload, TBinding> | null): void;
  context(): AuthorityProfileContext;
}): Promise<boolean> {
  let state = pending;
  if (!state) {
    const transition = acquire();
    try {
      if (!await prepare()) {
        transition.release();
        return false;
      }
      const selectedContext = context();
      state = {
        transition,
        context: selectedContext,
        payload: null,
        binding: null,
        completed: false,
      };
      onPendingChange(state);
      state.payload = await request();
      assertContext(selectedContext, context());
    } catch (error) {
      if (!state) transition.release();
      throw error;
    }
  } else {
    state.context = resumeContext(state.context, context());
  }
  try {
    assertContext(state.context, context());
    if (state.payload === null) {
      state.payload = await request();
      assertContext(state.context, context());
    }
    if (state.binding === null) {
      state.binding = await apply(state.payload);
      assertContext(state.context, context());
    }
    if (!state.completed) {
      await complete();
      assertContext(state.context, context());
      state.completed = true;
    }
    await settle(state.binding, true);
    assertContext(state.context, context());
    state.transition.release();
    onPendingChange(null);
    return true;
  } catch (error) {
    const current = context();
    if (current.profileEpoch === state.context.profileEpoch
      && current.serverIdentity === state.context.serverIdentity) {
      await refresh().catch(() => {});
      assertContext(state.context, context());
      await settle(state.binding, false);
      assertContext(state.context, context());
    }
    throw error;
  }
}

export async function runResultAuthorityTransition<TResult, TResolution>({
  replace,
  acquire,
  resolve,
  apply,
  refresh,
  pending = null,
  onPendingChange,
  context,
}: {
  replace: boolean;
  acquire(): AuthorityTransitionHandle;
  resolve(): Promise<TResolution>;
  apply(resolution: TResolution): Promise<TResult>;
  refresh(): Promise<void>;
  pending?: PendingResultAuthority<TResolution> | null;
  onPendingChange(pending: PendingResultAuthority<TResolution> | null): void;
  context(): AuthorityProfileContext;
}): Promise<TResult> {
  if (!replace) return apply(await resolve());
  let state = pending;
  if (!state) {
    const transition = acquire();
    try {
      const selectedContext = context();
      state = { transition, context: selectedContext, resolution: null };
      onPendingChange(state);
      state.resolution = await resolve();
      assertContext(selectedContext, context());
    } catch (error) {
      if (!state) transition.release();
      throw error;
    }
  } else state.context = resumeContext(state.context, context());
  try {
    assertContext(state.context, context());
    if (state.resolution === null) {
      state.resolution = await resolve();
      assertContext(state.context, context());
    }
    const result = await apply(state.resolution);
    assertContext(state.context, context());
    state.transition.release();
    onPendingChange(null);
    return result;
  } catch (error) {
    await refresh().catch(() => {});
    throw error;
  }
}
