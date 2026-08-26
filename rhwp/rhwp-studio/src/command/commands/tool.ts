import type { CommandDef } from '../types';

export const toolCommands: CommandDef[] = [
  {
    id: 'tool:options',
    label: '환경 설정',
    execute(services) {
      services.eventBus.emit('settings:open', { destination: 'editing' });
    },
  },
];
