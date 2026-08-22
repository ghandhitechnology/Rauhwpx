import type { CommandDef } from '../types';
import { getNativeFileSourcePath } from '../../desktop-integration';
import { OptionsDialog } from '../../ui/options-dialog';

export const toolCommands: CommandDef[] = [
  {
    id: 'tool:options',
    label: '환경 설정',
    execute(services) {
      const dlg = new OptionsDialog(services.eventBus, {
        getDocument: () => ({
          hasDocument: services.getContext().hasDocument,
          fileName: services.wasm.fileName,
          isUntitled: services.wasm.isNewDocument,
        }),
        resolveSourcePath: () => getNativeFileSourcePath(services.wasm.currentFileHandle),
      });
      dlg.show();
    },
  },
];
