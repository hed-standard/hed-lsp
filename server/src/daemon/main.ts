#!/usr/bin/env node

/**
 * The daemon process. It reads the configuration, listens on HOST and PORT, writes one JSON
 * `listening` line, and then loads the schemas in the background. On SIGTERM or SIGINT it stops
 * accepting, lets the requests in flight finish for up to 8 seconds, and exits 0.
 *
 * Exit codes: 0 after a signal, 2 for a configuration that is invalid (the message names the
 * variable), and 1 for a failure at run time, such as an address that cannot be bound.
 */

import { ConfigError, configWarnings, type DaemonConfig, loadConfig, readPackageVersion } from './config.js';
import { createLogger, errorDetail, type Logger } from './log.js';
import { createDaemon } from './server.js';

/**
 * How long a shutdown waits for requests in flight before it closes their connections. It is below
 * the 10 seconds that Docker waits after SIGTERM before it sends SIGKILL, so the daemon exits by
 * itself, with its connections closed in order, and is not killed in the middle of closing them.
 */
export const SHUTDOWN_GRACE_MS = 8_000;

export const EXIT_RUNTIME_FAILURE = 1;
export const EXIT_INVALID_CONFIG = 2;

/** Exit once everything written to stderr has been handed to the operating system. */
function exitAfterFlush(code: number): void {
	process.exitCode = code;
	process.stderr.write('', () => process.exit(code));
}

/** Read the configuration, or report the variable that is wrong and return null. */
function readConfig(logger: Logger): DaemonConfig | null {
	try {
		return loadConfig(process.env);
	} catch (error) {
		if (error instanceof ConfigError) {
			logger.error('invalid configuration', { variable: error.variable, detail: error.message });
			return null;
		}
		throw error;
	}
}

/** Start the daemon. Returns once the server is set up; the process stays alive while it listens. */
export function run(): void {
	const logger = createLogger();
	const config = readConfig(logger);
	if (!config) {
		exitAfterFlush(EXIT_INVALID_CONFIG);
		return;
	}
	for (const warning of configWarnings(config)) {
		logger.warn(warning);
	}

	const version = readPackageVersion(__dirname);
	// The preload starts after the listening line, so the process is reachable as soon as it is announced.
	const daemon = createDaemon(config, { autoPreload: false, version });
	let shuttingDown = false;

	const fail = (message: string, error: unknown): void => {
		// The system error code, such as EADDRINUSE, says why a bind failed and quotes no request.
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		logger.error(message, { ...errorDetail(error), code: typeof code === 'string' ? code : undefined });
		exitAfterFlush(EXIT_RUNTIME_FAILURE);
	};

	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info('shutting down', { signal, graceMs: SHUTDOWN_GRACE_MS });
		daemon.close(SHUTDOWN_GRACE_MS).then(
			() => {
				logger.info('stopped');
				exitAfterFlush(0);
			},
			(error: unknown) => fail('shutdown failed', error),
		);
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('uncaughtException', (error) => fail('uncaught exception', error));
	process.on('unhandledRejection', (reason) => fail('unhandled rejection', reason));

	daemon.server.on('error', (error) => fail('the server failed', error));
	daemon.server.once('listening', () => {
		const address = daemon.server.address();
		logger.info('listening', {
			host: config.host,
			port: typeof address === 'object' && address ? address.port : config.port,
			version,
			commit: config.commit,
			semantic: config.semantic,
		});
		void daemon.preload();
	});
	daemon.server.listen(config.port, config.host);
}

if (require.main === module) {
	run();
}
