import Mocha = require('mocha');
import * as vscode from 'vscode';
import { writeFileSync, renameSync } from 'fs';
import { join } from 'path';

function failureMessage(error: unknown): string {
    if (error instanceof AggregateError) {
        return `${error.message}\n${error.errors.map(failureMessage).join('\n')}`;
    }
    return error instanceof Error ? error.message : String(error);
}

export async function runLiveTests(extensionRoot: string): Promise<void> {
    const resultPath = process.env.AZDO_LIVE_RESULT;
    if (process.env.AZDO_LIVE_TESTS !== '1' || !resultPath) {
        throw new Error('Live tests require the explicit live runner.');
    }
    const failures: { title: string; message: string }[] = [];
    let passes = 0;
    try {
        const mocha = new Mocha({ ui: 'tdd', timeout: 180000 });
        mocha.addFile(join(extensionRoot, 'out', 'test', 'live', 'reviewWorkflow.live.js'));
        await new Promise<void>(resolve => {
            const runner = mocha.run(() => resolve());
            runner.on('pass', () => { passes++; });
            runner.on('fail', (test, error) => {
                failures.push({ title: test.fullTitle(), message: failureMessage(error) });
            });
        });
    } catch (error) {
        failures.push({ title: 'Live runner', message: failureMessage(error) });
    } finally {
        writeFileSync(`${resultPath}.tmp`, JSON.stringify({ passes, failures }, null, 2));
        renameSync(`${resultPath}.tmp`, resultPath);
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
}