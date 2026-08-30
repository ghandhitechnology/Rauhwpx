export function mergeCloudOperationSnapshot(operation, scoped) {
  if (!operation) return scoped;
  if (!Number.isSafeInteger(operation.profileEpoch)
    || !Number.isSafeInteger(scoped?.profileEpoch)
    || operation.profileEpoch !== scoped.profileEpoch) {
    throw Object.assign(
      new Error('Cloud profile changed before the operation response was delivered'),
      { code: 'PROFILE_CHANGED' },
    );
  }
  return {
    ...operation,
    ...scoped,
    profile: operation.profile ?? scoped.profile,
  };
}
