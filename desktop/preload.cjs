const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  getSessionContext: () => ipcRenderer.invoke('desktop:get-session-context'),
  getUniqueInstalls: () => ipcRenderer.invoke('desktop:get-unique-installs'),
  getLaunchFiles: () => ipcRenderer.invoke('desktop:get-launch-files'),
  getLaunchGeneratedDocument: () => ipcRenderer.invoke('desktop:get-launch-generated-document'),
  openGeneratedDocumentWindow: (payload) => ipcRenderer.invoke(
    'desktop:open-generated-document-window',
    payload,
  ),
  pickNativeOpenFile: (options) => ipcRenderer.invoke('desktop:pick-native-open-file', options),
  pickLegacyHistoryFolder: () => ipcRenderer.invoke('desktop:pick-legacy-history-folder'),
  claimNativeDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('desktop:claim-native-dropped-file', path) : null;
  },
  pickNativeSaveFile: (options) => ipcRenderer.invoke('desktop:pick-native-save-file', options),
  releaseNativeFile: (handleId) => ipcRenderer.invoke('desktop:release-native-file', handleId),
  readNativeFile: (handleId) => ipcRenderer.invoke('desktop:native-file-read', handleId),
  getNativeFileSourcePath: (handleId) => ipcRenderer.invoke(
    'desktop:native-file-source-path',
    handleId,
  ),
  validateNativeSave: (handleId, identity) => ipcRenderer.invoke(
    'desktop:native-file-validate-save',
    handleId,
    identity,
  ),
  writeNativeFile: (handleId, bytes, identity) => ipcRenderer.invoke(
    'desktop:native-file-write',
    handleId,
    bytes,
    identity,
  ),
  isSameNativeFile: (firstHandleId, secondHandleId) => ipcRenderer.invoke(
    'desktop:native-file-is-same',
    firstHandleId,
    secondHandleId,
  ),
  rememberNativeDocument: (documentId, handleId, digest) => ipcRenderer.invoke(
    'desktop:remember-native-document',
    documentId,
    handleId,
    digest,
  ),
  reopenNativeDocument: (documentId) => ipcRenderer.invoke(
    'desktop:reopen-native-document',
    documentId,
  ),
  searchNearbyNativeDocument: (documentId, options) => ipcRenderer.invoke(
    'desktop:search-nearby-native-document',
    documentId,
    options,
  ),
  readNativeProbe: (probeId) => ipcRenderer.invoke('desktop:native-probe-read', probeId),
  claimNativeProbe: (probeId) => ipcRenderer.invoke('desktop:native-probe-claim', probeId),
  verifyNativePick: (documentId, handleId) => ipcRenderer.invoke(
    'desktop:verify-native-pick',
    documentId,
    handleId,
  ),
  reserveDocument: (identity, nativeHandleId) => ipcRenderer.invoke(
    'desktop:document-reserve',
    identity,
    nativeHandleId,
  ),
  commitDocument: (reservationId) => ipcRenderer.invoke('desktop:document-commit', reservationId),
  cancelDocument: (reservationId) => ipcRenderer.invoke('desktop:document-cancel', reservationId),
  releaseDocument: () => ipcRenderer.invoke('desktop:document-release'),
  cloudGetState: (payload) => ipcRenderer.invoke('cloud:get-state', payload),
  cloudSaveProfile: (payload) => ipcRenderer.invoke('cloud:save-profile', payload),
  cloudTestProfile: (payload) => ipcRenderer.invoke('cloud:test-profile', payload),
  cloudProvision: (payload) => ipcRenderer.invoke('cloud:provision', payload),
  cloudPair: (payload) => ipcRenderer.invoke('cloud:pair', payload),
  cloudSelectServerMode: (payload) => ipcRenderer.invoke('cloud:select-server-mode', payload),
  cloudSpawnSandbox: (payload) => ipcRenderer.invoke('cloud:spawn-sandbox', payload),
  cloudSandboxStatus: () => ipcRenderer.invoke('cloud:sandbox-status'),
  cloudTeardownSandbox: (payload) => ipcRenderer.invoke('cloud:teardown-sandbox', payload),
  cloudForceQuitAccount: () => ipcRenderer.invoke('cloud:force-quit-account'),
  cloudReconnectLink: () => ipcRenderer.invoke('cloud:reconnect-link'),
  cloudRecreateLink: () => ipcRenderer.invoke('cloud:recreate-link'),
  cloudTakeoverSandbox: () => ipcRenderer.invoke('cloud:takeover-sandbox'),
  cloudAccountLogout: () => ipcRenderer.invoke('cloud:account-logout'),
  cloudTransfer: (payload) => ipcRenderer.invoke('cloud:transfer', payload),
  cloudSetTransferIntent: (payload) => ipcRenderer.invoke('cloud:transfer-intent', payload),
  cloudReadReference: (payload) => ipcRenderer.invoke('cloud:read-reference', payload),
  cloudCommand: (payload) => ipcRenderer.invoke('cloud:command', payload),
  cloudDismissSession: (payload) => ipcRenderer.invoke('cloud:dismiss-session', payload),
  cloudCompleteTakeover: (payload) => ipcRenderer.invoke('cloud:complete-takeover', payload),
  cloudDownloadResult: (payload) => ipcRenderer.invoke('cloud:download-result', payload),
  cloudDownloadCheckpoint: (payload) => ipcRenderer.invoke('cloud:download-checkpoint', payload),
  cloudPrepareRestartDocument: (payload) => ipcRenderer.invoke('cloud:prepare-restart-document', payload),
  cloudPublishCheckpoint: (payload) => ipcRenderer.invoke('cloud:publish-checkpoint', payload),
  cloudOpenDisplay: (payload) => ipcRenderer.invoke('cloud:display-open', payload),
  cloudCloseDisplay: (payload) => ipcRenderer.invoke('cloud:display-close', payload),
  cloudDisplayInput: (payload) => ipcRenderer.invoke('cloud:display-input', payload),
  cloudResolveResult: (payload) => ipcRenderer.invoke('cloud:resolve-result', payload),
  cloudBeginEdit: (payload) => ipcRenderer.invoke('cloud:begin-edit', payload),
  cloudContinueEdit: (payload) => ipcRenderer.invoke('cloud:continue-edit', payload),
  cloudPersistEditDraft: (payload) => ipcRenderer.invoke('cloud:edit-draft-save', payload),
  onCloudEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cloud:event', listener);
    return () => ipcRenderer.removeListener('cloud:event', listener);
  },
  onCloudDisplayEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cloud:display-event', listener);
    return () => ipcRenderer.removeListener('cloud:display-event', listener);
  },
  onCloudEditDraftSaveRequested: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cloud:edit-draft-save-requested', listener);
    return () => ipcRenderer.removeListener('cloud:edit-draft-save-requested', listener);
  },
  ensureAgentHub: () => ipcRenderer.invoke('agent-hub:ensure'),
  respondToCloseRequest: (requestId, allowClose) => (
    ipcRenderer.invoke('desktop:close-response', requestId, allowClose)
  ),
  onCloseRequested: (callback) => {
    ipcRenderer.on('desktop:close-requested', (_event, request) => callback(request));
  },
  platform: process.platform,
  setDocumentState: (state) => {
    ipcRenderer.send('desktop:set-document-state', { edited: state?.edited === true });
  },
  notifyAgentTurnFinished: (payload) => {
    ipcRenderer.send('desktop:agent-turn-finished', {
      title: String(payload?.title ?? ''),
      body: String(payload?.body ?? ''),
    });
  },
  setPendingReviewCount: (count) => {
    ipcRenderer.send('desktop:set-pending-review-count', Number(count) || 0);
  },
  showContextMenu: (items) => ipcRenderer.invoke('desktop:show-context-menu', items),
  showUnsavedChangesSheet: (payload) => ipcRenderer.invoke(
    'desktop:show-unsaved-changes-sheet',
    { fileName: String(payload?.fileName ?? '') },
  ),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreenChange: (callback) => {
    ipcRenderer.on('window:fullscreen-changed', (_event, fullscreen) => {
      callback(Boolean(fullscreen));
    });
  },
  onOpenFiles: (callback) => {
    ipcRenderer.on('desktop:open-files', (_event, files) => {
      callback(Array.isArray(files) ? files.map((file) => ({ ...file })) : []);
    });
  },
  onOpenGeneratedDocument: (callback) => {
    ipcRenderer.on('desktop:open-generated-document', (_event, payload) => {
      callback(payload);
    });
  },
  onEditCommand: (callback) => {
    ipcRenderer.on('desktop:edit-command', (_event, command) => callback(command));
  },
  onPastePlainText: (callback) => {
    ipcRenderer.on('desktop:paste-plain-text', (_event, text) => {
      callback(typeof text === 'string' ? text : '');
    });
  },
  setAppMenuModel: (model) => ipcRenderer.send('desktop:set-app-menu-model', model),
  onMenuCommand: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.commandId === 'string') callback(payload.commandId);
    };
    ipcRenderer.on('desktop:menu-command', listener);
    return () => ipcRenderer.removeListener('desktop:menu-command', listener);
  },
  onAgentCommand: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.command === 'string') callback(payload.command);
    };
    ipcRenderer.on('desktop:agent-command', listener);
    return () => ipcRenderer.removeListener('desktop:agent-command', listener);
  },
});
