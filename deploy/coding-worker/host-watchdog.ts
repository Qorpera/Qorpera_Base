import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type CodingHostWatchdogOutcome,
	runCodingHostWatchdog,
} from "../../packages/runner-orchestrator/src/coding-host-lease.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { codingErrorCode } from "../../packages/runtime/src/cloud-coding-error-code.ts";
import { readCodingServiceCredential } from "./credentials.ts";

/** The executor's LXD project, read from the same reviewed configuration the
 * executor loads (v7). Only the schema and the project are read: the executor
 * checks the rest when it starts, and an executor that refuses its
 * configuration writes no lease, so its machines are stopped either way. Not
 * executor.ts's parser: bundling executor.ts here would bundle its main too,
 * which starts whenever its bundle is the entry. */
export function codingHostWatchdogProject(value: unknown): string {
	const record = (entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		return entry as Record<string, unknown>;
	};
	const config = record(value);
	const { project } = record(config.vmPolicy);
	if (config.schema !== "qorpera.coding-executor-service/v7" || typeof project !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(project))
		throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return project;
}

export async function runCodingHostWatchdogWithRetry(
	options: Parameters<typeof runCodingHostWatchdog>[0] & {
		readonly retries?: number;
		readonly retryDelayMs?: number;
		readonly now?: () => number;
	},
): Promise<CodingHostWatchdogOutcome[]> {
	const retries = options.retries ?? 2;
	const retryDelayMs = options.retryDelayMs ?? 250;
	const now = options.now ?? (() => performance.now());
	const started = now();
	// WHY: retry fast double-scan VM transition mismatches without burning the watchdog pass budget on hung LXD.
	for (let attempt = 0; ; attempt++) {
		const attemptStarted = now();
		try {
			return await runCodingHostWatchdog(options);
		} catch (error) {
			const attemptElapsed = now() - attemptStarted;
			const totalElapsed = now() - started;
			if (
				attempt >= retries ||
				options.signal.aborted ||
				attemptElapsed >= 2_000 ||
				totalElapsed + retryDelayMs >= 10_000 ||
				codingErrorCode(error) !== "LXD_HOST_INVENTORY_UNCONFIRMED"
			)
				throw error;
			if (retryDelayMs > 0) await delay(retryDelayMs, undefined, { signal: options.signal });
		}
	}
}

/** One pass of qorpera-coding-host-watchdog.service, which its timer starts 5
 * seconds after the last one ended: every member machine VM in the executor's
 * project without a live host lease is force-stopped. It needs neither the
 * executor nor SQL, only LXD and the leases the executor writes. Each stop is
 * one JSON line and a quiet node logs nothing; a refused stop, or a pass that
 * could not look, exits 1. */
export async function runCodingHostWatchdogMain(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.()) throw new Error("UNPRIVILEGED_LINUX_REQUIRED");
	if (!environment.CREDENTIALS_DIRECTORY) throw new Error("CODING_CREDENTIALS_REQUIRED");
	const project = codingHostWatchdogProject(JSON.parse(await readCodingServiceCredential(environment.CREDENTIALS_DIRECTORY, "qorpera-coding-executor-config")));
	// Each stop waits at most 30 seconds for LXD, the pass 45: the unit gives it 60.
	const signal = AbortSignal.timeout(45_000);
	const outcomes = await runCodingHostWatchdogWithRetry({ client: new LxdUnixClient(undefined, 30), project, signal });
	for (const outcome of outcomes)
		console.log(JSON.stringify({ event: outcome.state === "failed" ? "coding-host-watchdog-error" : "coding-host-watchdog", ...outcome }));
	return outcomes.some((outcome) => outcome.state === "failed") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCodingHostWatchdogMain().then((code) => { process.exitCode = code; }, (error: unknown) => {
		console.error(JSON.stringify({ event: "coding-host-watchdog-error", code: codingErrorCode(error) }));
		process.exitCode = 1;
	});
}
