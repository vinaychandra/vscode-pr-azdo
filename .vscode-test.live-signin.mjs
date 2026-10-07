import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveExtensions, liveProfile, liveRoot, liveVersion } from './.vscode-test.live.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = join(liveRoot, 'signin-workspace');
mkdirSync(workspace, { recursive: true });
execFileSync('git', ['init', workspace], { stdio: 'ignore' });
const remotes = execFileSync('git', ['remote'], { cwd: workspace, encoding: 'utf-8' }).trim().split(/\s+/);
if (!remotes.includes('origin')) {
    execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/vinaychandra/Personal/_git/E2ETestRepo'], { cwd: workspace });
}
const executable = await downloadAndUnzipVSCode(liveVersion);
const child = spawn(executable, [
    workspace,
    '--new-window',
    '--user-data-dir', liveProfile,
    '--extensions-dir', liveExtensions,
    `--extensionDevelopmentPath=${root}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
], { detached: true, stdio: 'ignore' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
console.log('In the new VS Code window, run Azure DevOps PR: Sign In.');
console.log('After sign-in succeeds, close that window before running npm run test:live.');
console.log('This uses an isolated test profile and makes no repository changes.');