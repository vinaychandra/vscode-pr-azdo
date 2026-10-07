import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emptyWorkspace, liveExtensions, liveProfile, liveRoot, liveVersion } from './.vscode-test.live.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const results = join(liveRoot, 'results');
mkdirSync(results, { recursive: true });
const resultName = `${randomUUID()}.json`;
const resultPath = join(results, resultName);
const executable = await downloadAndUnzipVSCode(liveVersion);
console.log('Running live tests in the isolated VS Code profile. Close any sign-in window first.');

const outcome = await new Promise((resolve, reject) => {
    const watcher = watch(results, (_event, filename) => {
        if (filename !== resultName) { return; }
        try {
            const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
            clearTimeout(deadline);
            watcher.close();
            resolve(result);
        } catch (error) {
            clearTimeout(deadline);
            watcher.close();
            reject(error);
        }
    });
    const deadline = setTimeout(() => {
        watcher.close();
        reject(new Error(`Live tests did not finish within 10 minutes. Check the test window and ${liveRoot}.`));
    }, 600000);
    const child = spawn(executable, [
        emptyWorkspace,
        '--new-window',
        '--user-data-dir', liveProfile,
        '--extensions-dir', liveExtensions,
        `--extensionDevelopmentPath=${root}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
    ], {
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, AZDO_LIVE_TESTS: '1', AZDO_LIVE_RESULT: resultPath },
    });
    child.on('error', error => {
        clearTimeout(deadline);
        watcher.close();
        reject(error);
    });
    child.on('exit', code => {
        try {
            const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
            clearTimeout(deadline);
            watcher.close();
            resolve(result);
        } catch {
            clearTimeout(deadline);
            watcher.close();
            reject(new Error(`The test window exited (${code}) without a result. Check ${liveRoot}.`));
        }
    });
});

console.log(`${outcome.passes} passing, ${outcome.failures.length} failing`);
for (const failure of outcome.failures) { console.error(`${failure.title}: ${failure.message}`); }
console.log(`Results: ${resultPath}`);
process.exitCode = outcome.failures.length ? 1 : 0;