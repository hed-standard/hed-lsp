/**
 * Helpers for the tests of the scripts in deploy/hedtools and scripts: they run a script as it ships,
 * as a process, with real arguments and files. Nothing here stands in for a command or a service.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The repository root, three levels above server/src/__tests__ and server/out/__tests__ alike. */
export const ROOT = path.resolve(__dirname, '..', '..', '..');
export const DEPLOY = path.join(ROOT, 'deploy', 'hedtools');
export const SCRIPTS = path.join(ROOT, 'scripts');

const scratch: string[] = [];

/** Remove every directory made by `tempDir`. Call it from `afterAll`. */
export function removeTempDirs(): void {
	for (const dir of scratch.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

/** The first file called `name` on the PATH of this process, or undefined. */
export function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const file = path.join(dir, name);
		if (dir !== '' && fs.existsSync(file)) {
			return file;
		}
	}
	return undefined;
}

export function onPath(name: string): string {
	const file = findOnPath(name);
	if (!file) {
		throw new Error(`${name} is not on the PATH`);
	}
	return file;
}

/** The commands the scripts use. */
const TOOLS = [
	'awk',
	'cat',
	'cut',
	'curl',
	'date',
	'dirname',
	'grep',
	'head',
	'jq',
	'mktemp',
	'rm',
	'seq',
	'sed',
	'sleep',
	'sort',
	'tail',
	'tr',
	'wc',
];

/**
 * A directory of links to the commands the scripts use and no `docker`, so a script that tried to
 * call Docker would fail with "command not found", and one that probes for it finds none.
 */
export function pathWithoutDocker(): string {
	const bin = tempDir('hed-lsp-bin-');
	for (const name of TOOLS) {
		const file = findOnPath(name);
		if (file) {
			fs.symlinkSync(fs.realpathSync(file), path.join(bin, name));
		}
	}
	return bin;
}

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a program with these arguments and environment, and wait for it to exit. */
export function run(
	program: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = 60_000,
	cwd?: string,
): Promise<Result> {
	return new Promise((resolve) => {
		execFile(program, args, { env, cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
			resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
		});
	});
}

/** Run a script with bash. */
export function bash(script: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<Result> {
	return run(onPath('bash'), [script, ...args], env, timeoutMs);
}

/** A state directory holding an env file made of `content`. */
export function stateDirWith(content: string): string {
	const dir = tempDir('hed-lsp-state-');
	fs.writeFileSync(path.join(dir, 'hed-lsp.env'), content);
	return dir;
}

/** The environment of a script run: no Docker on the PATH, and this state directory. */
export function envFor(dir: string, extra: Record<string, string> = {}): Record<string, string> {
	return { PATH: pathWithoutDocker(), HOME: dir, HED_LSP_STATE_DIR: dir, ...extra };
}
