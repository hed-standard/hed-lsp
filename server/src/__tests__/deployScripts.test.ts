/**
 * Tests for the deployment tooling in deploy/hedtools: the shell scripts are run as they ship, as
 * processes, with real arguments and real files. The dry run of deploy.sh needs no Docker, so these
 * tests run it with a PATH that has no `docker` in it, which shows that it calls none. The env file
 * template is parsed by the daemon's own configuration reader. No mocks, no stand-in for a command.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../daemon/config.js';

/** The repository root, three levels above server/src/__tests__ and server/out/__tests__ alike. */
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'hedtools');
const ENV_EXAMPLE = path.join(DEPLOY, 'hed-lsp.env.example');

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

/** The first file called `name` on the PATH of this process. */
function onPath(name: string): string {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const file = path.join(dir, name);
		if (dir !== '' && fs.existsSync(file)) {
			return file;
		}
	}
	throw new Error(`${name} is not on the PATH`);
}

/**
 * A directory of links to the commands the scripts use before they reach Docker, and no `docker`,
 * so a script that tried to call it would fail with "command not found".
 */
function pathWithoutDocker(): string {
	const bin = tempDir('hed-lsp-bin-');
	for (const name of ['awk', 'cut', 'grep', 'sed', 'sort', 'tail', 'tr']) {
		fs.symlinkSync(fs.realpathSync(onPath(name)), path.join(bin, name));
	}
	return bin;
}

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a script with bash and the given environment, and wait for it to exit. */
function bash(script: string, args: string[], env: Record<string, string>): Promise<Result> {
	return new Promise((resolve) => {
		execFile(onPath('bash'), [script, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
			const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
			resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
		});
	});
}

/** A state directory holding an env file made of the template plus `extra` lines. */
function stateDir(extra = ''): string {
	const dir = tempDir('hed-lsp-state-');
	fs.writeFileSync(path.join(dir, 'hed-lsp.env'), fs.readFileSync(ENV_EXAMPLE, 'utf-8') + extra);
	return dir;
}

/** The environment of a script run: no Docker on the PATH, and this state directory. */
function envFor(dir: string): Record<string, string> {
	return { PATH: pathWithoutDocker(), HOME: dir, HED_LSP_STATE_DIR: dir };
}

const IMAGE_ID = `sha256:${'a1b2c3d4'.repeat(8)}`;
const DIGEST = `ghcr.io/hed-standard/hed-lsp-daemon@sha256:${'0f'.repeat(32)}`;

describe('deploy.sh --dry-run', () => {
	const script = path.join(DEPLOY, 'deploy.sh');

	it('prints the run command of the plan, exactly, and calls no Docker', async () => {
		const dir = stateDir();

		const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		const lines = result.stdout.split('\n').map((line) => line.trimEnd());
		const commands = lines.filter((line) => !line.startsWith('#'));
		const start = commands.indexOf('+ docker run -d --name hed-lsp --restart unless-stopped --network hed-lsp \\');
		expect(start).toBeGreaterThan(-1);
		expect(commands.slice(start, start + 8)).toEqual([
			'+ docker run -d --name hed-lsp --restart unless-stopped --network hed-lsp \\',
			'  -p 127.0.0.1:38530:38530 --stop-timeout 15 \\',
			'  --cpus 0.5 --cpu-shares 512 --memory 1g --memory-swap 1g --pids-limit 256 \\',
			'  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \\',
			'  -v hed-lsp-cache:/home/node/.cache \\',
			'  --log-opt max-size=20m --log-opt max-file=5 \\',
			`  --env-file ${path.join(dir, 'hed-lsp.env')} -e HED_LSP_TRUSTED_PROXIES=172.30.56.1 \\`,
			`  ${IMAGE_ID}`,
		]);
		expect(commands).toContain('+ docker network create --subnet 172.30.56.0/24 --gateway 172.30.56.1 hed-lsp');
		expect(commands).toContain('+ docker volume create hed-lsp-cache');
	});

	it('accepts the digest of a registry, and prints the settings it read without their values', async () => {
		const dir = stateDir('HED_LSP_EXAMPLE_VALUE=do-not-print-me\n');

		const result = await bash(script, ['--dry-run', DIGEST], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`  ${DIGEST}`);
		expect(result.stdout).toContain('(11 settings; semantic search off)');
		expect(result.stdout + result.stderr).not.toContain('do-not-print-me');
	});

	it.each([
		['a tag', 'hed-lsp-daemon:ci'],
		['the latest tag', 'hed-lsp-daemon:latest'],
		['a tag with a registry', 'ghcr.io/hed-standard/hed-lsp-daemon:0.4.0'],
		['a tag beside a digest', `ghcr.io/hed-standard/hed-lsp-daemon:0.4.0@sha256:${'0f'.repeat(32)}`],
		['a bare name', 'latest'],
		['a short image ID', '935b969520ba'],
		['a short sha256 ID', 'sha256:935b969520ba'],
		['an ID without the prefix', 'a1b2c3d4'.repeat(8)],
		['an ID in capitals', `sha256:${'A1B2C3D4'.repeat(8)}`],
		['an ID that is too long', `${IMAGE_ID}0`],
		['a digest of another algorithm', `ghcr.io/x/y@sha512:${'0f'.repeat(32)}`],
	])('refuses %s', async (_label, image) => {
		const result = await bash(script, ['--dry-run', image], envFor(stateDir()));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain(`refusing '${image}'`);
	});

	it('also refuses a tag in a real run, before it touches Docker', async () => {
		const result = await bash(script, ['hed-lsp-daemon:ci'], envFor(stateDir()));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("refusing 'hed-lsp-daemon:ci'");
	});

	it.each([
		[[], 'an image ID or digest is required'],
		[['--bogus', IMAGE_ID], 'unknown option: --bogus'],
		[[IMAGE_ID, IMAGE_ID], 'one image only'],
		[['--cpus'], '--cpus needs a value'],
		[['--cpus', '0', IMAGE_ID], '--cpus must be above 0'],
		[['--cpus', 'half', IMAGE_ID], '--cpus must be a number'],
		[['--memory', '1.5g', IMAGE_ID], '--memory must be a whole number'],
		[['--memory', '0g', IMAGE_ID], '--memory must be a whole number'],
		[['--memory', 'lots', IMAGE_ID], '--memory must be a whole number'],
	])('refuses the arguments %j', async (args, message) => {
		const result = await bash(script, ['--dry-run', ...args], envFor(stateDir()));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
	});

	it('sets the limits from the options, and drops --read-only only when asked', async () => {
		const result = await bash(
			script,
			['--dry-run', '--cpus', '2', '--memory', '512m', '--no-read-only', IMAGE_ID],
			envFor(stateDir()),
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('--cpus 2 --cpu-shares 512 --memory 512m --memory-swap 512m --pids-limit 256');
		expect(result.stdout).toContain('  --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges');
		expect(result.stdout).not.toContain('--read-only');
		expect(result.stdout).toContain('writable root file system');
	});

	it.each([
		['1', '3g'],
		['true', '3g'],
		['  TRUE ', '3g'],
		['0', '1g'],
		['false', '1g'],
	])('uses the memory of semantic search %j: %s', async (value, memory) => {
		// The last HED_LSP_SEMANTIC line wins, as it does for the daemon.
		const dir = stateDir(`HED_LSP_SEMANTIC=${value}\n`);

		const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`--memory ${memory} --memory-swap ${memory}`);
		expect(result.stdout).toContain(`semantic search ${memory === '3g' ? 'on' : 'off'}`);
	});

	it('lets --memory override the memory chosen for semantic search', async () => {
		const result = await bash(
			script,
			['--dry-run', '--memory', '4g', IMAGE_ID],
			envFor(stateDir('HED_LSP_SEMANTIC=1\n')),
		);

		expect(result.stdout).toContain('--memory 4g --memory-swap 4g');
	});

	describe('checks the env file without printing a value', () => {
		it('stops when the file is missing, and names the path', async () => {
			const dir = tempDir('hed-lsp-empty-');

			const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`env file not found: ${path.join(dir, 'hed-lsp.env')}`);
		});

		it('names the line of an entry that is not a HED_LSP_ setting, and never its value', async () => {
			const dir = stateDir('HED_LSP_OK=1\nPASSWORD=hunter2-secret\nexport HED_LSP_X=hunter3-secret\n');
			const lines = fs.readFileSync(path.join(dir, 'hed-lsp.env'), 'utf-8').split('\n');
			const first = lines.indexOf('PASSWORD=hunter2-secret') + 1;

			const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`line(s) ${first} ${first + 1}`);
			expect(result.stdout + result.stderr).not.toContain('hunter');
		});

		it.each(['HED_LSP_PORT', 'HED_LSP_HOST', 'HED_LSP_TRUSTED_PROXIES'])(
			'refuses %s, which the script fixes',
			async (name) => {
				const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(stateDir(`${name}=do-not-print-me\n`)));

				expect(result.code).toBe(1);
				expect(result.stderr).toContain(`env file sets ${name}`);
				expect(result.stdout + result.stderr).not.toContain('do-not-print-me');
			},
		);

		it('refuses a file with Windows line endings', async () => {
			const dir = tempDir('hed-lsp-crlf-');
			fs.writeFileSync(path.join(dir, 'hed-lsp.env'), 'HED_LSP_SEMANTIC=0\r\n');

			const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('carriage returns');
		});
	});

	it('prints its usage for --help', async () => {
		const result = await bash(script, ['--help'], envFor(stateDir()));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Usage: deploy.sh [--dry-run]');
		expect(result.stdout).toContain('never a tag');
		expect(result.stdout).not.toContain('set -euo');
	});
});

describe('hed-lsp.env.example', () => {
	const settings = fs
		.readFileSync(ENV_EXAMPLE, 'utf-8')
		.split('\n')
		.filter((line) => /^HED_LSP_[A-Z0-9_]+=/.test(line))
		.map((line) => line.split('=') as [string, string]);

	it('lists settings the daemon reads, each with its default, so a fresh copy changes nothing', () => {
		const fromFile = loadConfig(Object.fromEntries(settings));
		const defaults = loadConfig({});

		// The image turns the download off with HED_LSP_MODEL_DOWNLOAD=0; the program's own default is on.
		expect(fromFile).toEqual({ ...defaults, modelDownload: false });
		expect(settings.length).toBeGreaterThanOrEqual(10);
	});

	it('names no setting twice, none the script fixes, and holds no secret', () => {
		const names = settings.map(([name]) => name);

		expect(new Set(names).size).toBe(names.length);
		for (const fixed of ['HED_LSP_HOST', 'HED_LSP_PORT', 'HED_LSP_TRUSTED_PROXIES']) {
			expect(names).not.toContain(fixed);
		}
		expect(names.filter((name) => /TOKEN|SECRET|PASSWORD|KEY/.test(name))).toEqual([]);
	});
});
