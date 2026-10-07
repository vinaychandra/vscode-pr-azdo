import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const liveRoot = join(dirname(fileURLToPath(import.meta.url)), '.vscode-test', 'live');
export const liveProfile = join(liveRoot, 'user-data');
export const liveExtensions = join(liveRoot, 'extensions');
export const emptyWorkspace = join(liveRoot, 'empty-workspace');
mkdirSync(emptyWorkspace, { recursive: true });
export const liveVersion = '1.140.0';