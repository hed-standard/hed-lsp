/**
 * Tests for the deployment tooling in deploy/hedtools: the shell scripts are run as they ship, as
 * processes, with real arguments and real files. The dry run of deploy.sh needs no Docker, so these
 * tests run it with a PATH that has no `docker` in it, which shows that it calls none. The env file
 * template is parsed by the daemon's own configuration reader, and the settings check that deploy.sh
 * runs in a container is run here as the same program against the compiled daemon of this checkout.
 * What needs a Docker container (the record of the last good image, the polling of a new container)
 * is checked on the host at the approval gates of the runbook. No mocks, no stand-in for a command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../daemon/config.js';
import { bash, DEPLOY, envFor, ROOT, removeTempDirs, run, stateDirWith, tempDir } from './scriptHarness.js';

const ENV_EXAMPLE = path.join(DEPLOY, 'hed-lsp.env.example');

afterAll(removeTempDirs);

/** A state directory holding an env file made of the template plus `extra` lines. */
function stateDir(extra = ''): string {
	return stateDirWith(fs.readFileSync(ENV_EXAMPLE, 'utf-8') + extra);
}

/** Every file in a directory with its content, to show that a run wrote nothing. */
function snapshot(dir: string): Record<string, string> {
	return Object.fromEntries(
		fs
			.readdirSync(dir)
			.sort()
			.map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf-8')]),
	);
}

/**
 * What `docker run --env-file` makes of a file: NAME=value lines with the value taken as written (no quote
 * is removed and no comment is cut), and blank and comment lines skipped.
 */
function dockerEnvFile(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const entry = line.trimStart();
		if (entry === '' || entry.startsWith('#')) {
			continue;
		}
		const at = entry.indexOf('=');
		env[entry.slice(0, at)] = entry.slice(at + 1);
	}
	return env;
}

const IMAGE_ID = `sha256:${'a1b2c3d4'.repeat(8)}`;
const DIGEST = `ghcr.io/hed-standard/hed-lsp-daemon@sha256:${'0f'.repeat(32)}`;

describe('deploy.sh --dry-run', () => {
	const script = path.join(DEPLOY, 'deploy.sh');

	it('prints the run command of the runbook, exactly, and calls no Docker', async () => {
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
		expect(result.stdout).toContain('--rollback');
	});

	it('prints every step in order, writes nothing, and ends with the rollback command', async () => {
		const dir = stateDir();
		const before = snapshot(dir);

		const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		const text = result.stdout;
		const steps = [
			'+ docker run --rm --network none --env-file ',
			'+ docker network create ',
			'+ docker volume create ',
			`> ${path.join(dir, 'previous-image-id')}`,
			'+ docker tag <image ID of the running container> hed-lsp-daemon:previous',
			'+ docker stop hed-lsp',
			'+ docker rm hed-lsp',
			'+ docker run -d --name hed-lsp ',
			'+ docker container inspect --format ',
			'--rollback',
		].map((step) => text.indexOf(step));
		expect(steps.every((index) => index > -1)).toBe(true);
		expect(steps).toEqual([...steps].sort((a, b) => a - b));
		// The record is made before the old container is stopped, and the poll reads the restart state.
		expect(text).toContain('{{.State.Restarting}} {{.RestartCount}}');
		expect(text).toContain('remove nothing');
		expect(text).toMatch(/^\+ \S+\/deploy\.sh --rollback\s*$/m);
		expect(snapshot(dir)).toEqual(before);
	});
});

describe('deploy.sh --rollback', () => {
	const script = path.join(DEPLOY, 'deploy.sh');
	const RECORDED = `sha256:${'5e'.repeat(32)}`;
	const record = (dir: string, content: string): void => {
		fs.writeFileSync(path.join(dir, 'previous-image-id'), content);
	};

	it.each([
		['a dry run', ['--dry-run', '--rollback']],
		['a real run', ['--rollback']],
	])('refuses when no image is recorded, in %s, before it touches Docker', async (_label, args) => {
		const dir = stateDir();

		const result = await bash(script, args, envFor(dir));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('nothing to roll back to');
		expect(result.stderr).toContain(path.join(dir, 'previous-image-id'));
		expect(fs.existsSync(path.join(dir, 'previous-image-id'))).toBe(false);
	});

	it.each([
		['a tag', 'hed-lsp-daemon:previous\n'],
		['a short ID', 'sha256:935b969520ba\n'],
		['an ID in capitals', `sha256:${'5E'.repeat(32)}\n`],
		['a digest of a registry', `ghcr.io/hed-standard/hed-lsp-daemon@sha256:${'0f'.repeat(32)}\n`],
		['an empty file', ''],
	])('refuses a record that holds %s', async (_label, content) => {
		const dir = stateDir();
		record(dir, content);

		const result = await bash(script, ['--dry-run', '--rollback'], envFor(dir));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('does not hold an image ID');
	});

	it.each([
		['a tag', 'hed-lsp-daemon:previous'],
		['an image ID', RECORDED],
	])('takes no image: %s beside --rollback is refused', async (_label, image) => {
		const dir = stateDir();
		record(dir, `${RECORDED}\n`);

		const result = await bash(script, ['--dry-run', '--rollback', image], envFor(dir));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('takes no image');
	});

	it('plans the same steps for the recorded image, repeats --no-read-only but not the limits, and writes nothing', async () => {
		const dir = stateDir();
		record(dir, `${RECORDED}\n`);
		const before = snapshot(dir);

		const result = await bash(script, ['--dry-run', '--rollback', '--cpus', '2', '--no-read-only'], envFor(dir));

		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain(
			`Rollback: the image is the one recorded in ${path.join(dir, 'previous-image-id')}`,
		);
		expect(result.stdout).toContain(`Image:    ${RECORDED}`);
		expect(result.stdout).toContain(`records the image ${RECORDED}`);
		expect(result.stdout).toMatch(/--entrypoint node sha256:5e5e\w+ -e '/);
		expect(result.stdout).toContain(`  ${RECORDED} \n`);
		// The limits are not repeated: a rollback takes them from the settings file, so a limit that failed is never restored.
		expect(result.stdout).toMatch(/^\+ \S+\/deploy\.sh --rollback --no-read-only\s*$/m);
		expect(result.stdout).not.toMatch(/^\+ \S+\/deploy\.sh --rollback .*--cpus/m);
		expect(snapshot(dir)).toEqual(before);
	});

	it('names the rollback in its usage', async () => {
		const result = await bash(script, ['--help'], envFor(stateDir()));

		expect(result.stdout).toContain('--rollback       Start the image whose ID is recorded');
		expect(result.stdout).toContain('Rolling back is `deploy.sh --rollback`');
	});
});

describe('deploy.sh settings check', () => {
	const script = path.join(DEPLOY, 'deploy.sh');
	const server = path.join(ROOT, 'server');
	// The ENV lines of the Dockerfile are part of the environment of the image that the check runs in.
	const imageEnv = Object.fromEntries(
		[
			...fs
				.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8')
				.matchAll(/^\s*(?:ENV\s+)?(HED_LSP_(?:HOST|PORT|MODEL_DOWNLOAD))=(\S+)/gm),
		].map((match) => [match[1], match[2]]),
	);

	/**
	 * Run the program of the settings check that `deploy.sh --dry-run` prints: the same JavaScript, the same
	 * env file, and the same overrides, in the server directory of this checkout in place of /app/server in
	 * the image, against the compiled daemon. Docker is not involved; the env file is read as Docker reads it.
	 */
	async function check(dir: string) {
		const dry = await bash(script, ['--dry-run', IMAGE_ID], envFor(dir));
		const line = dry.stdout.split('\n').find((candidate) => candidate.startsWith('+ docker run --rm --network none '));
		expect(line, dry.stdout + dry.stderr).toBeDefined();
		const snippet = /-e '([^']*)'\s*$/.exec(line ?? '')?.[1];
		expect(snippet).toBeDefined();
		const overrides = Object.fromEntries(
			[...(line ?? '').matchAll(/ -e (HED_LSP_[A-Z_]+)=(\S+)/g)].map((match) => [match[1], match[2]]),
		);
		expect(overrides).toEqual({ HED_LSP_TRUSTED_PROXIES: '172.30.56.1' });
		expect(fs.existsSync(path.join(server, 'out', 'daemon', 'config.js')), 'run bun run compile first').toBe(true);
		const env = {
			PATH: process.env.PATH ?? '',
			...imageEnv,
			...dockerEnvFile(fs.readFileSync(path.join(dir, 'hed-lsp.env'), 'utf-8')),
			...overrides,
		};
		return run(process.execPath, ['-e', snippet ?? ''], env, 30_000, server);
	}

	it('accepts the template as it ships, and a semantic-on file', async () => {
		const shipped = await check(stateDir());
		const semantic = await check(stateDir('HED_LSP_SEMANTIC=1\nHED_LSP_ONNX_THREADS=2\n'));

		expect(shipped).toEqual({ code: 0, stdout: '', stderr: '' });
		expect(semantic).toEqual({ code: 0, stdout: '', stderr: '' });
	});

	it.each([
		['a comment after the value', 'HED_LSP_SEMANTIC=1 # on', 'HED_LSP_SEMANTIC must be 0, 1, true, or false', '# on'],
		['a quoted value', 'HED_LSP_SEMANTIC="1"', 'HED_LSP_SEMANTIC must be 0, 1, true, or false', '"'],
		[
			'a word for a number',
			'HED_LSP_MAX_IN_FLIGHT=eight-do-not-print',
			'HED_LSP_MAX_IN_FLIGHT must be an integer',
			'eight',
		],
		[
			'a number out of range',
			'HED_LSP_ONNX_THREADS=0',
			'HED_LSP_ONNX_THREADS must be an integer from 1 to 1024',
			'got',
		],
		['a setting that must be 1', 'HED_LSP_SEMANTIC_CONCURRENCY=2', 'HED_LSP_SEMANTIC_CONCURRENCY must be 1', 'got'],
	])('refuses %s, names the variable, and never prints the value', async (_label, line, message, hidden) => {
		const result = await check(stateDir(`${line}\n`));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr.trim()).toContain(message);
		expect(result.stderr).not.toContain(hidden);
		expect(result.stderr.trim().split('\n')).toHaveLength(1);
	});

	it('is run before the network, the volume, the record, and the stop', async () => {
		const result = await bash(script, ['--dry-run', IMAGE_ID], envFor(stateDir()));

		const text = result.stdout;
		const checkAt = text.indexOf('--entrypoint node');
		for (const later of [
			'docker network create',
			'docker volume create',
			'# 3. When the container exists, is healthy',
			'docker stop hed-lsp',
		]) {
			expect(checkAt, later).toBeGreaterThan(-1);
			expect(text.indexOf(later), later).toBeGreaterThan(checkAt);
		}
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
