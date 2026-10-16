/**
 * Tests for the deployment tooling in deploy/hedtools: the shell scripts are run as they ship, as
 * processes, with real arguments and real files. The dry run of deploy.sh needs no Docker, so these
 * tests run it with a PATH that has no `docker` in it, which shows that it calls none. The env file
 * template is parsed by the daemon's own configuration reader. No mocks, no stand-in for a command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../daemon/config.js';
import { bash, DEPLOY, envFor, ROOT, removeTempDirs, stateDirWith, tempDir } from './scriptHarness.js';

const ENV_EXAMPLE = path.join(DEPLOY, 'hed-lsp.env.example');

afterAll(removeTempDirs);

/** A state directory holding an env file made of the template plus `extra` lines. */
function stateDir(extra = ''): string {
	return stateDirWith(fs.readFileSync(ENV_EXAMPLE, 'utf-8') + extra);
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
		const inTemplate = fs
			.readFileSync(ENV_EXAMPLE, 'utf-8')
			.split('\n')
			.filter((line) => /^HED_LSP_\w+=/.test(line)).length;

		const result = await bash(script, ['--dry-run', DIGEST], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`  ${DIGEST}`);
		expect(result.stdout).toContain(`(${inTemplate + 1} settings; semantic search off)`);
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

	it('lists documented daemon settings with their defaults, so a fresh copy changes nothing', () => {
		const daemonSettings = settings.filter(([name]) => name !== 'HED_LSP_IMAGE_ID');
		const fromFile = loadConfig(Object.fromEntries(daemonSettings));
		const defaults = loadConfig({});
		const documented = fs.readFileSync(path.join(ROOT, 'docs', 'daemon.md'), 'utf-8');

		// The image turns the download off with HED_LSP_MODEL_DOWNLOAD=0; the program's own default is on.
		expect(fromFile).toEqual({ ...defaults, modelDownload: false });
		expect(daemonSettings.length).toBeGreaterThanOrEqual(10);
		for (const [name] of daemonSettings) {
			expect(documented, name).toContain(`\`${name.replace('HED_LSP_', '')}\``);
		}
	});

	it('leaves the image pin of measure.sh empty until the image is known', () => {
		expect(settings).toContainEqual(['HED_LSP_IMAGE_ID', '']);
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
