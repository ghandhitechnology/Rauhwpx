const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  getSessionContext: () => ipcRenderer.invoke('desktop:get-session-context'),
  getLaunchFiles: () => ipcRenderer.invoke('desktop:get-launch-files'),
  getLaunchGeneratedDocument: () => ipcRenderer.invoke('desktop:get-launch-generated-document'),
  openGeneratedDocumentWindow: (payload) => ipcRenderer.invoke(
    'desktop:open-generated-document-window',
    payload,
  ),
  pickNativeOpenFile: (options) => ipcRenderer.invoke('desktop:pick-native-open-file', options),
  claimNativeDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('desktop:claim-native-dropped-file', path) : null;
  },
  pickNativeSaveFile: (options) => ipcRenderer.invoke('desktop:pick-native-save-file', options),
  savePortableHistoryFile: (payload) => ipcRenderer.invoke(
    'desktop:save-portable-history-file',
    payload,
  ),
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
  writePortableHistoryFile: (handleId, files, identity) => ipcRenderer.invoke(
    'desktop:native-file-write-portable-history',
    handleId,
    files,
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
  cloudTransfer: (payload) => ipcRenderer.invoke('cloud:transfer', payload),
  cloudSetTransferIntent: (payload) => ipcRenderer.invoke('cloud:transfer-intent', payload),
  cloudReadReference: (payload) => ipcRenderer.invoke('cloud:read-reference', payload),
  cloudCommand: (payload) => ipcRenderer.invoke('cloud:command', payload),
  cloudCompleteTakeover: (payload) => ipcRenderer.invoke('cloud:complete-takeover', payload),
  cloudDownloadResult: (payload) => ipcRenderer.invoke('cloud:download-result', payload),
  cloudResolveResult: (payload) => ipcRenderer.invoke('cloud:resolve-result', payload),
  onCloudEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cloud:event', listener);
    return () => ipcRenderer.removeListener('cloud:event', listener);
  },
  ensureAgentHub: () => ipcRenderer.invoke('agent-hub:ensure'),
  respondToCloseRequest: (requestId, allowClose) => (
    ipcRenderer.invoke('desktop:close-response', requestId, allowClose)
  ),
  onCloseRequested: (callback) => {
    ipcRenderer.on('desktop:close-requested', (_event, request) => callback(request));
  },
  platform: process.platform,
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
  onPastePlainText: (callback) => {
    ipcRenderer.on('desktop:paste-plain-text', (_event, text) => {
      callback(typeof text === 'string' ? text : '');
    });
  },
});
