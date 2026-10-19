import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const testRoot = join(root, '.vscode-test', 'copilot');
const workspace = join(testRoot, 'workspace');
const profile = join(testRoot, 'user-data');
const extensions = join(testRoot, 'extensions');
const resultPath = join(testRoot, `result-${Date.now()}.json`);
const signingIn = process.argv.includes('--signin');
const baseline = [
    '/** Divide by a nonzero divisor; throw for zero. */',
    'export function divide(value: number, divisor: number): number {',
    '    if (divisor === 0) { throw new Error("Divisor must be nonzero"); }',
    '    return value / divisor;',
    '}',
    '',
].join('\n');
const defective = baseline.replace('divisor === 0', 'divisor !== 0');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(profile, 'User'), { recursive: true });
if (!existsSync(join(profile, 'User', 'settings.json'))) {
    writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
    }, null, 2));
}
const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
if (!existsSync(join(workspace, '.git'))) {
    if (readdirSync(workspace).length !== 0) { throw new Error('Refusing to initialize a nonempty smoke-test directory.'); }
    git(['init', '--initial-branch=feature']);
    git(['config', 'core.autocrlf', 'false']);
    writeFileSync(join(workspace, 'calculator.ts'), baseline);
    git(['add', 'calculator.ts']);
    git(['-c', 'user.name=Copilot Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Correct baseline']);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
    writeFileSync(join(workspace, 'calculator.ts'), defective);
    git(['add', 'calculator.ts']);
    git(['-c', 'user.name=Copilot Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Introduce deliberate review defect']);
    git(['update-ref', 'refs/remotes/origin/feature', git(['rev-parse', 'HEAD'])]);
}
if (git(['status', '--porcelain'])) {
    throw new Error('The synthetic Copilot fixture has local edits. Preserve or remove those edits before rerunning; this runner never resets files.');
}
if (git(['remote'])) { throw new Error('The synthetic Copilot fixture must not have any configured remotes.'); }
if (git(['ls-files']) !== 'calculator.ts'
    || readFileSync(join(workspace, 'calculator.ts'), 'utf8') !== defective
    || execFileSync('git', ['show', 'origin/main:calculator.ts'], { cwd: workspace, encoding: 'utf8' }) !== baseline
    || readdirSync(workspace).some(name => name !== '.git' && name !== 'calculator.ts')) {
    throw new Error('Refusing to review anything other than the known synthetic Copilot fixture.');
}
const executable = await downloadAndUnzipVSCode('1.142.0');
console.log(signingIn
    ? 'Sign into GitHub Copilot in the isolated development window, then close that window.'
    : 'Running a real Copilot review against the local-only synthetic fixture. Approve the review tools if prompted.');
const child = spawn(executable, [
    workspace, '--new-window', '--user-data-dir', profile, '--extensions-dir', extensions,
    `--extensionDevelopmentPath=${root}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
], {
    stdio: 'inherit',
    env: {
        ...process.env, ELECTRON_RUN_AS_NODE: undefined,
        AZDO_LIVE_TESTS: undefined, AZDO_LIVE_RESULT: undefined,
        AZDO_COPILOT_SMOKE: signingIn ? undefined : '1',
        AZDO_COPILOT_SMOKE_RESULT: signingIn ? undefined : resultPath,
    },
});
const deadline = signingIn ? undefined : setTimeout(() => {
    console.error('The Copilot smoke test exceeded six minutes. Closing only its isolated application process.');
    child.kill();
}, 360000);
const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code));
});
if (deadline) { clearTimeout(deadline); }
if (signingIn) {
    process.exitCode = result ?? 1;
} else {
    if (!existsSync(resultPath)) { throw new Error('The smoke-test window closed without recording a result.'); }
    const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.success) { process.exitCode = 1; }
}
