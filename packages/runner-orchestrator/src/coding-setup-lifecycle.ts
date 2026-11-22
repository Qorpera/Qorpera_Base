import type { CodingSetup, CodingSetupCommand, CodingSetupStep, CodingSetupTerminal } from "./coding-setup.ts";

export const CODING_SETUP_MAX_TERMINALS = 8;
export const CODING_SETUP_DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const CODING_SETUP_DEFAULT_START_TIMEOUT_MS = 2 * 60_000;
export const CODING_SETUP_DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
export const CODING_SETUP_DEFAULT_DEPENDENCY_TIMEOUT_MS = 2 * 60_000;
export const CODING_SETUP_MAX_ENV_ENTRIES = 128;
export const CODING_SETUP_MAX_ENV_VALUE_BYTES = 4096;
export const CODING_SETUP_MAX_ERROR_OUTPUT_BYTES = 8192;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTAINER_ENV_REF = /\$\{containerEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const PROTECTED_ENV_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"NODE_OPTIONS",
	"BASH_ENV",
	"ENV",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"NPM_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"SUPABASE_SERVICE_ROLE_KEY",
]);

function isProtectedEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	if (PROTECTED_ENV_NAMES.has(upper)) return true;
	if (upper.startsWith("QORPERA_")) return true;
	return false;
}

export type CodingSetupLifecyclePhase = "env" | "repositoryDependencies" | "install" | "start" | "terminals";

export class CodingSetupLifecycleError extends Error {
	readonly code: string;
	readonly phase: CodingSetupLifecyclePhase;
	readonly stepName: string | null;
	readonly exitCode: number | null;
	readonly output: string;

	constructor(details: {
		readonly code: string;
		readonly phase: CodingSetupLifecyclePhase;
		readonly message: string;
		readonly stepName?: string | null;
		readonly exitCode?: number | null;
		readonly output?: string;
		readonly cause?: unknown;
	}) {
		super(details.message, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "CodingSetupLifecycleError";
		this.code = details.code;
		this.phase = details.phase;
		this.stepName = details.stepName ?? null;
		this.exitCode = details.exitCode ?? null;
		this.output = truncateErrorOutput(details.output ?? "");
	}
}

export interface CodingSetupResolvedEnv {
	readonly env: Readonly<Record<string, string>>;
	readonly skipped: readonly string[];
}

export function resolveCodingSetupEnvironment(setupSpec: CodingSetup): CodingSetupResolvedEnv {
	const base = new Map<string, string>();
	const skipped: string[] = [];

	for (const [key, value] of Object.entries(setupSpec.containerEnv)) {
		if (!validateEnvPair(key, value)) {
			skipped.push(key);
			continue;
		}
		if (base.size >= CODING_SETUP_MAX_ENV_ENTRIES) {
			skipped.push(key);
			continue;
		}
		base.set(key, value);
	}

	const resolved = new Map<string, string>(base);
	for (const [key, rawValue] of Object.entries(setupSpec.remoteEnv)) {
		if (isProtectedEnvName(key) || !ENV_NAME.test(key)) {
			skipped.push(key);
			continue;
		}
		if (rawValue === null) {
			resolved.delete(key);
			continue;
		}
		const expanded = rawValue.replace(CONTAINER_ENV_REF, (_match, ref: string) => base.get(ref) ?? "");
		if (!validateEnvPair(key, expanded)) {
			skipped.push(key);
			continue;
		}
		if (!resolved.has(key) && resolved.size >= CODING_SETUP_MAX_ENV_ENTRIES) {
			skipped.push(key);
			continue;
		}
		resolved.set(key, expanded);
	}

	const out: Record<string, string> = {};
	for (const key of [...resolved.keys()].sort()) {
		out[key] = resolved.get(key) as string;
	}
	return { env: Object.freeze(out), skipped: Object.freeze(skipped) };
}

function validateEnvPair(key: string, value: string): boolean {
	if (!ENV_NAME.test(key) || isProtectedEnvName(key)) return false;
	if (value.includes("\0") || Buffer.byteLength(value, "utf8") > CODING_SETUP_MAX_ENV_VALUE_BYTES) return false;
	return true;
}

export interface CodingSetupCommandInput {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}

export interface CodingSetupCommandOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CodingSetupCommandRunner {
	exec(input: CodingSetupCommandInput, signal: AbortSignal): Promise<CodingSetupCommandOutput>;
}

export interface CodingSetupDependencyPreparer {
	prepare(dependency: { readonly repository: string; readonly cwd: string }, signal: AbortSignal): Promise<void>;
}

export interface CodingSetupTrackedTerminal {
	readonly name: string;
	readonly command: string;
	readonly pid: number | null;
	readonly logPath: string;
}

export interface CodingSetupAttachContext {
	readonly machineId: string;
	readonly workerId: string;
	readonly diskId: string;
	readonly bootId: string;
	readonly cwd: string;
	readonly setupDigest: string;
	readonly setupSpec: CodingSetup;
	readonly snapshotPreinstalled?: boolean;
	readonly runner: CodingSetupCommandRunner;
	readonly prepareDependency?: CodingSetupDependencyPreparer["prepare"];
}

export interface CodingSetupAttachResult {
	readonly env: Readonly<Record<string, string>>;
	readonly skippedEnv: readonly string[];
	readonly ranInstall: boolean;
	readonly ranStart: boolean;
	readonly startedTerminals: readonly CodingSetupTrackedTerminal[];
	readonly preparedDependencies: readonly string[];
}

export interface CodingSetupLifecycleOptions {
	readonly installTimeoutMs?: number;
	readonly startTimeoutMs?: number;
	readonly terminalTimeoutMs?: number;
	readonly dependencyTimeoutMs?: number;
	readonly maxTerminals?: number;
	readonly report?: (event: Record<string, unknown>) => void;
}

interface SessionLifecycleRecord {
	readonly machineId: string;
	readonly workerId: string;
	installedKey: string | null;
	startedBootKey: string | null;
	terminals: CodingSetupTrackedTerminal[];
	lastRunner: CodingSetupCommandRunner | null;
	lastCwd: string | null;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncateErrorOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= CODING_SETUP_MAX_ERROR_OUTPUT_BYTES) return output;
	return `...[truncated]\n${output.slice(-CODING_SETUP_MAX_ERROR_OUTPUT_BYTES)}`;
}

function sessionKey(machineId: string, workerId: string): string {
	return `${machineId}:${workerId}`;
}

function commandArgv(command: CodingSetupCommand): readonly string[] {
	return "shell" in command ? ["/bin/sh", "-lc", command.shell] : [...command.argv];
}

export class CodingSetupLifecycle {
	readonly #installTimeoutMs: number;
	readonly #startTimeoutMs: number;
	readonly #terminalTimeoutMs: number;
	readonly #dependencyTimeoutMs: number;
	readonly #maxTerminals: number;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #sessions = new Map<string, SessionLifecycleRecord>();

	constructor(options: CodingSetupLifecycleOptions = {}) {
		this.#installTimeoutMs = options.installTimeoutMs ?? CODING_SETUP_DEFAULT_INSTALL_TIMEOUT_MS;
		this.#startTimeoutMs = options.startTimeoutMs ?? CODING_SETUP_DEFAULT_START_TIMEOUT_MS;
		this.#terminalTimeoutMs = options.terminalTimeoutMs ?? CODING_SETUP_DEFAULT_TERMINAL_TIMEOUT_MS;
		this.#dependencyTimeoutMs = options.dependencyTimeoutMs ?? CODING_SETUP_DEFAULT_DEPENDENCY_TIMEOUT_MS;
		this.#maxTerminals = Math.max(
			1,
			Math.min(options.maxTerminals ?? CODING_SETUP_MAX_TERMINALS, CODING_SETUP_MAX_TERMINALS),
		);
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
	}

	trackedTerminals(machineId: string, workerId: string): readonly CodingSetupTrackedTerminal[] {
		return this.#sessions.get(sessionKey(machineId, workerId))?.terminals ?? [];
	}

	async onAttach(context: CodingSetupAttachContext, signal: AbortSignal): Promise<CodingSetupAttachResult> {
		signal.throwIfAborted();
		const { env, skipped } = resolveCodingSetupEnvironment(context.setupSpec);
		const key = sessionKey(context.machineId, context.workerId);
		let record = this.#sessions.get(key);
		if (!record) {
			record = {
				machineId: context.machineId,
				workerId: context.workerId,
				installedKey: null,
				startedBootKey: null,
				terminals: [],
				lastRunner: null,
				lastCwd: null,
			};
			this.#sessions.set(key, record);
		}
		record.lastRunner = context.runner;
		record.lastCwd = context.cwd;

		const preparedDependencies: string[] = [];
		const installKey = `${context.diskId}:${context.setupDigest}`;
		const bootKey = `${context.diskId}:${context.bootId}:${context.setupDigest}`;

		const needsInstall =
			record.installedKey !== installKey && !context.snapshotPreinstalled && context.setupSpec.install.length > 0;

		if (record.installedKey !== installKey && context.setupSpec.repositoryDependencies.length > 0) {
			for (const repository of context.setupSpec.repositoryDependencies) {
				signal.throwIfAborted();
				if (context.prepareDependency) {
					const depSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#dependencyTimeoutMs)]);
					try {
						await context.prepareDependency({ repository, cwd: context.cwd }, depSignal);
					} catch (error) {
						if (signal.aborted) throw signal.reason;
						throw new CodingSetupLifecycleError({
							code: "CODING_SETUP_DEPENDENCY_FAILED",
							phase: "repositoryDependencies",
							stepName: repository,
							message: `Preparing repository dependency ${repository} failed.`,
							output: error instanceof Error ? error.message : String(error),
							cause: error,
						});
					}
				}
				preparedDependencies.push(repository);
			}
		}

		let ranInstall = false;
		if (needsInstall) {
			await this.#runPhaseSteps(
				"install",
				context.setupSpec.install,
				context.cwd,
				env,
				this.#installTimeoutMs,
				context.runner,
				signal,
			);
			ranInstall = true;
		}
		record.installedKey = installKey;

		let ranStart = false;
		const startedTerminals: CodingSetupTrackedTerminal[] = [];
		if (record.startedBootKey !== bootKey) {
			if (record.terminals.length > 0) {
				await this.#stopTerminalList(record.terminals, context.runner, context.cwd);
				record.terminals = [];
			}
			if (context.setupSpec.start.length > 0) {
				await this.#runPhaseSteps(
					"start",
					context.setupSpec.start,
					context.cwd,
					env,
					this.#startTimeoutMs,
					context.runner,
					signal,
				);
				ranStart = true;
			}
			const flatTerminals = context.setupSpec.terminals.flat();
			if (flatTerminals.length > 0) {
				const bounded = flatTerminals.slice(0, this.#maxTerminals);
				const nextTerminals: CodingSetupTrackedTerminal[] = [];
				try {
					for (const [index, terminal] of bounded.entries()) {
						signal.throwIfAborted();
						const started = await this.#startTerminal(context, terminal, index, env, signal);
						nextTerminals.push(started);
						startedTerminals.push(started);
					}
				} catch (error) {
					await this.#stopTerminalList(nextTerminals, context.runner, context.cwd);
					throw error;
				}
				record.terminals = nextTerminals;
			} else {
				record.terminals = [];
			}
			record.startedBootKey = bootKey;
		}

		this.#report({
			event: "coding-setup-lifecycle-attach",
			machineId: context.machineId,
			workerId: context.workerId,
			setupDigest: context.setupDigest,
			ranInstall,
			ranStart,
			terminals: record.terminals.length,
			dependencies: preparedDependencies.length,
		});

		return {
			env,
			skippedEnv: skipped,
			ranInstall,
			ranStart,
			startedTerminals,
			preparedDependencies,
		};
	}

	async onDetach(machineId: string, workerId: string, runner?: CodingSetupCommandRunner): Promise<void> {
		const key = sessionKey(machineId, workerId);
		const record = this.#sessions.get(key);
		if (!record) return;
		const activeRunner = runner ?? record.lastRunner;
		if (record.terminals.length > 0 && activeRunner && record.lastCwd) {
			await this.#stopTerminalList(record.terminals, activeRunner, record.lastCwd);
		}
		record.terminals = [];
		record.startedBootKey = null;
	}

	onMachineStopped(machineId: string): void {
		for (const record of this.#sessions.values()) {
			if (record.machineId !== machineId) continue;
			record.startedBootKey = null;
			record.terminals = [];
		}
	}

	onMachineNewDisk(machineId: string): void {
		for (const record of this.#sessions.values()) {
			if (record.machineId !== machineId) continue;
			record.installedKey = null;
			record.startedBootKey = null;
			record.terminals = [];
		}
	}

	forgetMachine(machineId: string): void {
		for (const [key, record] of this.#sessions) {
			if (record.machineId === machineId) this.#sessions.delete(key);
		}
	}

	forgetSession(machineId: string, workerId: string): void {
		this.#sessions.delete(sessionKey(machineId, workerId));
	}

	async #runPhaseSteps(
		phase: "install" | "start",
		steps: readonly CodingSetupStep[],
		cwd: string,
		env: Readonly<Record<string, string>>,
		timeoutMs: number,
		runner: CodingSetupCommandRunner,
		signal: AbortSignal,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (const step of steps) {
			signal.throwIfAborted();
			if (step.commands.length === 0) continue;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new CodingSetupLifecycleError({
					code: `CODING_SETUP_${phase.toUpperCase()}_TIMEOUT`,
					phase,
					stepName: step.from,
					message: `Setup ${phase} phase exceeded timeout of ${timeoutMs}ms.`,
				});
			}
			if (step.commands.length === 1) {
				await this.#runCommand(phase, step.from, step.commands[0], cwd, env, remainingMs, runner, signal);
			} else {
				await Promise.all(
					step.commands.map((cmd) =>
						this.#runCommand(phase, step.from, cmd, cwd, env, remainingMs, runner, signal),
					),
				);
			}
		}
	}

	async #runCommand(
		phase: "install" | "start",
		from: string,
		command: CodingSetupStep["commands"][number],
		cwd: string,
		env: Readonly<Record<string, string>>,
		timeoutMs: number,
		runner: CodingSetupCommandRunner,
		signal: AbortSignal,
	): Promise<void> {
		const stepName = command.name ? `${from}:${command.name}` : from;
		const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		let output: CodingSetupCommandOutput;
		try {
			output = await runner.exec(
				{
					argv: commandArgv(command.run),
					cwd,
					env,
					timeoutMs,
				},
				stepSignal,
			);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			const timedOut = stepSignal.aborted;
			throw new CodingSetupLifecycleError({
				code: timedOut
					? `CODING_SETUP_${phase.toUpperCase()}_TIMEOUT`
					: `CODING_SETUP_${phase.toUpperCase()}_FAILED`,
				phase,
				stepName,
				message: timedOut
					? `Setup ${phase} hook "${stepName}" timed out after ${timeoutMs}ms.`
					: `Setup ${phase} hook "${stepName}" could not run.`,
				output: error instanceof Error ? error.message : String(error),
				cause: error,
			});
		}
		if (output.exitCode !== 0) {
			const combined = [output.stdout, output.stderr].filter(Boolean).join("\n");
			throw new CodingSetupLifecycleError({
				code: `CODING_SETUP_${phase.toUpperCase()}_FAILED`,
				phase,
				stepName,
				exitCode: output.exitCode,
				message: `Setup ${phase} hook "${stepName}" exited with status ${output.exitCode}.`,
				output: combined,
			});
		}
	}

	async #startTerminal(
		context: CodingSetupAttachContext,
		terminal: CodingSetupTerminal,
		index: number,
		env: Readonly<Record<string, string>>,
		signal: AbortSignal,
	): Promise<CodingSetupTrackedTerminal> {
		const name = terminal.name ?? `terminal-${index + 1}`;
		const safeId = `${context.workerId.replaceAll("-", "").slice(0, 12)}-${index}`;
		const logPath = `/tmp/qorpera-terminal-${safeId}.log`;
		const launchScript = `if command -v setsid >/dev/null 2>&1; then setsid /bin/sh -lc ${shellQuote(terminal.command)} >${shellQuote(logPath)} 2>&1 < /dev/null & else nohup /bin/sh -lc ${shellQuote(terminal.command)} >${shellQuote(logPath)} 2>&1 < /dev/null & fi; echo $!`;
		const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#terminalTimeoutMs)]);
		let output: CodingSetupCommandOutput;
		try {
			output = await context.runner.exec(
				{
					argv: ["/bin/sh", "-lc", launchScript],
					cwd: context.cwd,
					env,
					timeoutMs: this.#terminalTimeoutMs,
				},
				stepSignal,
			);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			throw new CodingSetupLifecycleError({
				code: "CODING_SETUP_TERMINAL_FAILED",
				phase: "terminals",
				stepName: name,
				message: `Setup terminal "${name}" failed to launch.`,
				output: error instanceof Error ? error.message : String(error),
				cause: error,
			});
		}
		if (output.exitCode !== 0) {
			throw new CodingSetupLifecycleError({
				code: "CODING_SETUP_TERMINAL_FAILED",
				phase: "terminals",
				stepName: name,
				exitCode: output.exitCode,
				message: `Setup terminal "${name}" failed to launch with status ${output.exitCode}.`,
				output: [output.stdout, output.stderr].filter(Boolean).join("\n"),
			});
		}
		const pidMatch = /^\s*([1-9][0-9]*)\s*$/.exec(output.stdout.trim());
		const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
		return { name, command: terminal.command, pid, logPath };
	}

	async #stopTerminalList(
		terminals: readonly CodingSetupTrackedTerminal[],
		runner: CodingSetupCommandRunner,
		cwd: string,
	): Promise<void> {
		const pids = terminals.map((t) => t.pid).filter((pid): pid is number => pid !== null && pid > 1);
		if (pids.length === 0) return;
		const signal = AbortSignal.timeout(10_000);
		const pidArgs = pids.flatMap((pid) => [`-${pid}`, String(pid)]).join(" ");
		await runner
			.exec(
				{
					argv: [
						"/bin/sh",
						"-lc",
						`kill -TERM ${pidArgs} 2>/dev/null || true; sleep 0.2; kill -KILL ${pidArgs} 2>/dev/null || true`,
					],
					cwd,
					env: {},
					timeoutMs: 10_000,
				},
				signal,
			)
			.catch(() => undefined);
	}
}
