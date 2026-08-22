import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudRunnerCapability } from "./cloud-runner-control.ts";
import { type CloudRunnerModelSocketFactory, startCloudRunnerModelSocketServer } from "./cloud-runner-model-socket.ts";
import type {
	CloudRunnerSandboxBackend,
	CloudRunnerSandboxGuarantees,
	CloudRunnerSandboxProcess,
	CloudRunnerSandboxRequest,
} from "./cloud-runner-sandbox.ts";

const CONTAINER_REQUEST_SCHEMA = "qorpera.ephemeral-container-request/v1";
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_PATHS = Object.freeze({
	companyBaseRoot: "/qorpera/input/company",
	companyRoot: "/qorpera/work/company",
	executionContextPath: "/qorpera/input/execution.json",
	queuedInputsPath: "/qorpera/input/inputs.jsonl",
	transcriptPath: "/qorpera/input/transcript.jsonl",
	substrateManifestPath: "/qorpera/input/substrate.json",
	operationsPath: "/qorpera/input/operations.jsonl",
	artifactsRoot: "/qorpera/input/artifacts",
	outputRoot: "/qorpera/output",
	modelBrokerSocket: "/qorpera/broker/model.sock",
});
const MAX_COMMAND_STDERR_BYTES = 16 * 1024;
const MAX_CONTAINER_REQUEST_BYTES = 128 * 1024;
const MAX_PODMAN_INFO_BYTES = 256 * 1024;
const OUTPUT_TMPFS_OVERHEAD_BYTES = 1024 * 1024;
const STALE_CONTAINER_NAME_PATTERN =
	/^qorpera-job-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_WORKSPACE_NAME_PATTERN = /^qorpera-runner-[A-Za-z0-9]{6}$/;

export interface PodmanCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface PodmanCommandProcess {
	readonly completion: Promise<PodmanCommandResult>;
	readonly firstStdoutLine: Promise<string>;
	terminateClient(): void;
}

export interface PodmanCommandLimits {
	stdoutBytes: number;
	stderrBytes: number;
	timeoutMs: number;
}

export interface PodmanCommandTransport {
	readonly platform: NodeJS.Platform;
	start(executable: string, args: readonly string[], input: string, limits: PodmanCommandLimits): PodmanCommandProcess;
}

export interface RootlessPodmanSandboxBackendOptions {
	image: string;
	capabilities: readonly CloudRunnerCapability[];
	jobTypes: readonly string[];
	podmanPath?: string;
	entrypoint?: string;
	temporaryRoot?: string;
	commandTransport?: PodmanCommandTransport;
	modelSocketFactory?: CloudRunnerModelSocketFactory;
}

function restrictedPodmanEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
	};
	for (const key of [
		"HOME",
		"XDG_RUNTIME_DIR",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"DBUS_SESSION_BUS_ADDRESS",
		"TMPDIR",
	] as const) {
		const value = process.env[key];
		if (value) environment[key] = value;
	}
	return environment;
}

export class NodePodmanCommandTransport implements PodmanCommandTransport {
	readonly platform = process.platform;
	readonly #environment: NodeJS.ProcessEnv;

	constructor(environment: NodeJS.ProcessEnv = restrictedPodmanEnvironment()) {
		this.#environment = { ...environment };
	}

	start(
		executable: string,
		args: readonly string[],
		input: string,
		limits: PodmanCommandLimits,
	): PodmanCommandProcess {
		if (
			!Number.isSafeInteger(limits.stdoutBytes) ||
			limits.stdoutBytes < 0 ||
			!Number.isSafeInteger(limits.stderrBytes) ||
			limits.stderrBytes < 0 ||
			!Number.isSafeInteger(limits.timeoutMs) ||
			limits.timeoutMs < 1 ||
			limits.timeoutMs > 25 * 60 * 60 * 1000
		) {
			throw new Error("Podman command limits are invalid");
		}
		const child: ChildProcessWithoutNullStreams = spawn(executable, [...args], {
			cwd: "/",
			env: this.#environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let boundaryError: Error | undefined;
		let resolveFirstStdoutLine: (line: string) => void = () => undefined;
		let firstStdoutLineSettled = false;
		const firstStdoutLine = new Promise<string>((resolve) => {
			resolveFirstStdoutLine = resolve;
		});
		const timer = setTimeout(() => {
			boundaryError ??= new Error("Podman command exceeded its wall-time limit");
			child.kill("SIGKILL");
		}, limits.timeoutMs);
		timer.unref();
		const collect = (chunks: Buffer[], maximum: number, label: string, chunk: Buffer): void => {
			if (boundaryError) return;
			const current = label === "stdout" ? stdoutBytes : stderrBytes;
			const next = current + chunk.byteLength;
			if (!Number.isSafeInteger(next) || next > maximum) {
				boundaryError = new Error(`Podman ${label} exceeded its byte limit`);
				child.kill("SIGKILL");
				return;
			}
			if (label === "stdout") stdoutBytes = next;
			else stderrBytes = next;
			chunks.push(Buffer.from(chunk));
		};
		child.stdout.on("data", (chunk: Buffer) => {
			collect(stdout, limits.stdoutBytes, "stdout", chunk);
			if (boundaryError || firstStdoutLineSettled) return;
			const buffered = Buffer.concat(stdout);
			const newline = buffered.indexOf(0x0a);
			if (newline < 0) return;
			firstStdoutLineSettled = true;
			resolveFirstStdoutLine(buffered.subarray(0, newline).toString("utf-8"));
		});
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, limits.stderrBytes, "stderr", chunk));
		child.stdin.on("error", () => undefined);
		child.stdin.end(input);
		const completion = new Promise<PodmanCommandResult>((resolveCompletion, rejectCompletion) => {
			let spawnError: Error | undefined;
			child.once("error", (error) => {
				spawnError = error;
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (boundaryError) {
					rejectCompletion(boundaryError);
					return;
				}
				if (spawnError) {
					rejectCompletion(new Error("Podman process could not be started", { cause: spawnError }));
					return;
				}
				if (code === null) {
					rejectCompletion(new Error("Podman process ended without an exit status"));
					return;
				}
				resolveCompletion({
					exitCode: code,
					stdout: Buffer.concat(stdout).toString("utf-8"),
					stderr: Buffer.concat(stderr).toString("utf-8"),
				});
			});
		});
		return {
			completion,
			firstStdoutLine,
			terminateClient: () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			},
		};
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Podman returned invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function commandSucceeded(result: PodmanCommandResult, label: string): void {
	if (result.exitCode !== 0) throw new Error(`${label} failed with exit status ${result.exitCode}`);
}

function safeHostPath(path: string): string {
	if (!isAbsolute(path) || /[\0\r\n,]/.test(path)) throw new Error("Podman mount path is unsafe");
	return path;
}

function safeContainerEntrypoint(value: string): string {
	if (
		!value.startsWith("/") ||
		!/^[A-Za-z0-9._/-]+$/.test(value) ||
		value.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error("Podman container entrypoint is invalid");
	}
	return value;
}

function assertEnvironment(environment: Readonly<Record<string, string>>): void {
	for (const [key, value] of Object.entries(environment)) {
		if (
			!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) ||
			value.length > 4096 ||
			/[\0\r\n]/.test(value) ||
			/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|API_KEY/.test(key)
		) {
			throw new Error("Podman container environment contains an invalid entry");
		}
	}
}

function assertRequest(request: CloudRunnerSandboxRequest): void {
	if (
		!UUID_PATTERN.test(request.job.jobId) ||
		!UUID_PATTERN.test(request.substrate.versionId) ||
		!JOB_TYPE_PATTERN.test(request.job.jobType) ||
		!Number.isSafeInteger(request.job.attemptCount) ||
		request.job.attemptCount < 1 ||
		!Number.isSafeInteger(request.limits.wallTimeMs) ||
		request.limits.wallTimeMs < 10 ||
		request.limits.wallTimeMs > 24 * 60 * 60 * 1000 ||
		!Number.isSafeInteger(request.limits.memoryBytes) ||
		request.limits.memoryBytes < 64 * 1024 * 1024 ||
		request.limits.memoryBytes > 256 * 1024 * 1024 * 1024 ||
		!Number.isFinite(request.limits.cpuCount) ||
		request.limits.cpuCount < 0.1 ||
		request.limits.cpuCount > 64 ||
		!Number.isSafeInteger(request.limits.maxPids) ||
		request.limits.maxPids < 1 ||
		request.limits.maxPids > 4096 ||
		!Number.isSafeInteger(request.limits.maxInputBytes) ||
		request.limits.maxInputBytes < 1 ||
		request.limits.maxInputBytes > 16 * 1024 * 1024 * 1024 ||
		!Number.isSafeInteger(request.limits.maxOutputBytes) ||
		request.limits.maxOutputBytes < 0 ||
		request.limits.maxOutputBytes > 256 * 1024 * 1024 ||
		!Number.isSafeInteger(request.limits.maxResultBytes) ||
		request.limits.maxResultBytes < 2 ||
		request.limits.maxResultBytes > 64 * 1024
	) {
		throw new Error("Podman sandbox request is invalid");
	}
	const payload = JSON.stringify(request.job.payload);
	if (payload === undefined || Buffer.byteLength(payload) > 64 * 1024) {
		throw new Error("Podman sandbox payload is invalid");
	}
	assertEnvironment(request.environment);
}

async function verifiedMounts(
	request: CloudRunnerSandboxRequest,
): Promise<{ inputRoot: string; workRoot: string; outputRoot: string; brokerRoot?: string }> {
	const [
		companyBaseRoot,
		companyRoot,
		executionContextPath,
		queuedInputsPath,
		transcriptPath,
		substrateManifestPath,
		operationsPath,
		artifactsRoot,
		attachmentsRoot,
		outputRoot,
	] = await Promise.all([
		realpath(request.input.companyBaseRoot),
		realpath(request.input.companyRoot),
		realpath(request.input.executionContextPath),
		realpath(request.input.queuedInputsPath),
		realpath(request.input.transcriptPath),
		realpath(request.input.substrateManifestPath),
		realpath(request.input.operationsPath),
		realpath(request.input.artifactsRoot),
		realpath(request.input.attachmentsRoot),
		realpath(request.outputRoot),
	]);
	const inputRoot = dirname(companyBaseRoot);
	const workRoot = dirname(companyRoot);
	if (
		companyBaseRoot !== join(inputRoot, "company") ||
		companyRoot !== join(workRoot, "company") ||
		workRoot !== join(dirname(inputRoot), "work") ||
		executionContextPath !== join(inputRoot, "execution.json") ||
		queuedInputsPath !== join(inputRoot, "inputs.jsonl") ||
		transcriptPath !== join(inputRoot, "transcript.jsonl") ||
		substrateManifestPath !== join(inputRoot, "substrate.json") ||
		operationsPath !== join(inputRoot, "operations.jsonl") ||
		artifactsRoot !== join(inputRoot, "artifacts") ||
		attachmentsRoot !== join(inputRoot, "attachments") ||
		outputRoot !== join(dirname(inputRoot), "output")
	) {
		throw new Error("Podman sandbox paths do not match the disposable job layout");
	}
	const [
		companyBase,
		company,
		executionContext,
		queuedInputs,
		transcript,
		manifest,
		operations,
		artifacts,
		attachments,
		output,
	] = await Promise.all([
		stat(companyBaseRoot),
		stat(companyRoot),
		stat(executionContextPath),
		stat(queuedInputsPath),
		stat(transcriptPath),
		stat(substrateManifestPath),
		stat(operationsPath),
		stat(artifactsRoot),
		stat(attachmentsRoot),
		stat(outputRoot),
	]);
	if (
		!companyBase.isDirectory() ||
		!company.isDirectory() ||
		!executionContext.isFile() ||
		!queuedInputs.isFile() ||
		!transcript.isFile() ||
		!manifest.isFile() ||
		!operations.isFile() ||
		!artifacts.isDirectory() ||
		!attachments.isDirectory() ||
		!output.isDirectory()
	) {
		throw new Error("Podman sandbox layout has invalid filesystem entries");
	}
	if ((await readdir(outputRoot)).length > 0) throw new Error("Podman sandbox output directory must start empty");
	if (!request.hostBroker) {
		return {
			inputRoot: safeHostPath(inputRoot),
			workRoot: safeHostPath(workRoot),
			outputRoot: safeHostPath(outputRoot),
		};
	}
	const brokerRoot = await realpath(request.hostBroker.root);
	const broker = await lstat(request.hostBroker.root);
	if (
		brokerRoot !== request.hostBroker.root ||
		brokerRoot !== join(dirname(inputRoot), "broker") ||
		!broker.isDirectory() ||
		broker.isSymbolicLink()
	) {
		throw new Error("Podman model broker path does not match the disposable job layout");
	}
	return {
		inputRoot: safeHostPath(inputRoot),
		workRoot: safeHostPath(workRoot),
		outputRoot: safeHostPath(outputRoot),
		brokerRoot: safeHostPath(brokerRoot),
	};
}

export class RootlessPodmanSandboxBackend implements CloudRunnerSandboxBackend {
	readonly backendId = "podman-rootless-v1";
	readonly guarantees: Readonly<CloudRunnerSandboxGuarantees> = Object.freeze({
		boundary: "rootless_container",
		hostFilesystem: "none",
		inputFilesystem: "read_only",
		companyCheckout: "job_private",
		outputFilesystem: "job_private",
		network: "deny_by_default",
		environment: "allowlist_only",
		privileges: "unprivileged",
		resourceLimits: "kernel_enforced",
		termination: "boundary_destroyed",
	});
	readonly capabilities: readonly CloudRunnerCapability[];
	readonly jobTypes: readonly string[];
	readonly #image: string;
	readonly #podmanPath: string;
	readonly #entrypoint: string;
	readonly #temporaryRoot?: string;
	readonly #commands: PodmanCommandTransport;
	readonly #modelSocketFactory: CloudRunnerModelSocketFactory;
	#runtimeReady?: Promise<void>;

	constructor(options: RootlessPodmanSandboxBackendOptions) {
		if (!IMAGE_PATTERN.test(options.image)) {
			throw new Error("Podman runner image must be pinned by SHA-256 digest");
		}
		if (
			options.capabilities.length < 1 ||
			new Set(options.capabilities).size !== options.capabilities.length ||
			options.jobTypes.length < 1 ||
			new Set(options.jobTypes).size !== options.jobTypes.length ||
			options.jobTypes.some((jobType) => !JOB_TYPE_PATTERN.test(jobType))
		) {
			throw new Error("Podman runner support declarations are invalid");
		}
		this.#image = options.image;
		this.#podmanPath = safeHostPath(options.podmanPath ?? "/usr/bin/podman");
		this.#entrypoint = safeContainerEntrypoint(options.entrypoint ?? "/qorpera/bin/run-job");
		this.#temporaryRoot = options.temporaryRoot ? safeHostPath(options.temporaryRoot) : undefined;
		this.#commands = options.commandTransport ?? new NodePodmanCommandTransport();
		this.#modelSocketFactory = options.modelSocketFactory ?? startCloudRunnerModelSocketServer;
		this.capabilities = Object.freeze([...options.capabilities]);
		this.jobTypes = Object.freeze([...options.jobTypes]);
	}

	async prepare(): Promise<void> {
		await this.#ensureRuntime();
	}

	async start(request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess> {
		assertRequest(request);
		if (!this.capabilities.includes(request.job.requiredCapability) || !this.jobTypes.includes(request.job.jobType)) {
			throw new Error("Podman backend does not support this runner job");
		}
		await this.#ensureRuntime();
		const mounts = await verifiedMounts(request);
		const containerName = `qorpera-job-${randomUUID()}`;
		const containerRequest = `${JSON.stringify({
			schema: CONTAINER_REQUEST_SCHEMA,
			job: request.job,
			substrate: request.substrate,
			paths: request.hostBroker
				? CONTAINER_PATHS
				: {
						companyRoot: CONTAINER_PATHS.companyRoot,
						companyBaseRoot: CONTAINER_PATHS.companyBaseRoot,
						executionContextPath: CONTAINER_PATHS.executionContextPath,
						queuedInputsPath: CONTAINER_PATHS.queuedInputsPath,
						transcriptPath: CONTAINER_PATHS.transcriptPath,
						substrateManifestPath: CONTAINER_PATHS.substrateManifestPath,
						operationsPath: CONTAINER_PATHS.operationsPath,
						artifactsRoot: CONTAINER_PATHS.artifactsRoot,
						outputRoot: CONTAINER_PATHS.outputRoot,
					},
			limits: request.limits,
		})}\n`;
		if (Buffer.byteLength(containerRequest) > MAX_CONTAINER_REQUEST_BYTES) {
			throw new Error("Podman container request exceeds its byte limit");
		}
		const args = [
			"run",
			"--name",
			containerName,
			"--label",
			"io.qorpera.ephemeral-runner=true",
			"--pull=never",
			"--network=none",
			"--read-only",
			"--read-only-tmpfs=false",
			"--image-volume=ignore",
			"--cap-drop=all",
			"--security-opt=no-new-privileges",
			"--pids-limit",
			String(request.limits.maxPids),
			"--memory",
			String(request.limits.memoryBytes),
			"--memory-swap",
			String(request.limits.memoryBytes),
			"--cpus",
			String(request.limits.cpuCount),
			"--userns=keep-id:size=1024",
			"--ipc=private",
			"--pid=private",
			"--cgroupns=private",
			"--uts=private",
			"--hostname=qorpera-job",
			"--no-hosts",
			"--http-proxy=false",
			"--unsetenv-all",
			"--log-driver=none",
			"--interactive",
			"--restart=no",
			"--sdnotify=ignore",
			"--stop-timeout=0",
			"--timeout",
			String(Math.ceil(request.limits.wallTimeMs / 1000)),
			"--umask=077",
			"--workdir",
			CONTAINER_PATHS.companyRoot,
			"--entrypoint",
			this.#entrypoint,
			"--mount",
			`type=bind,src=${mounts.inputRoot},dst=/qorpera/input,ro=true,relabel=private,bind-propagation=rprivate,bind-nonrecursive`,
			"--mount",
			`type=bind,src=${mounts.workRoot},dst=/qorpera/work,rw=true,relabel=private,bind-propagation=rprivate,bind-nonrecursive`,
			"--mount",
			`type=tmpfs,destination=${CONTAINER_PATHS.outputRoot},tmpfs-size=${request.limits.maxOutputBytes + OUTPUT_TMPFS_OVERHEAD_BYTES},tmpfs-mode=0700,notmpcopyup,U=true`,
		];
		if (mounts.brokerRoot) {
			args.push(
				"--mount",
				`type=bind,src=${mounts.brokerRoot},dst=/qorpera/broker,ro=true,relabel=private,bind-propagation=rprivate,bind-nonrecursive`,
			);
		}
		for (const [key, value] of Object.entries(request.environment).sort(([left], [right]) =>
			left.localeCompare(right, "en"),
		)) {
			args.push("--env", `${key}=${value}`);
		}
		args.push(this.#image);
		const modelSocket =
			request.hostBroker && mounts.brokerRoot
				? await this.#modelSocketFactory({
						socketPath: join(mounts.brokerRoot, "model.sock"),
						broker: request.hostBroker.model,
					})
				: undefined;
		let container: PodmanCommandProcess;
		try {
			container = this.#commands.start(this.#podmanPath, args, containerRequest, {
				stdoutBytes: request.limits.maxResultBytes + 1,
				stderrBytes: MAX_COMMAND_STDERR_BYTES,
				timeoutMs: request.limits.wallTimeMs + 30_000,
			});
		} catch (error) {
			await modelSocket?.close();
			throw error;
		}
		let removal: Promise<void> | undefined;
		const remove = (): Promise<void> => {
			removal ??= this.#removeContainer(containerName);
			return removal;
		};
		const result = (async (): Promise<JsonValue> => {
			try {
				const line = await Promise.race([
					container.firstStdoutLine,
					container.completion.then((completed) => {
						commandSucceeded(completed, "Podman runner container");
						throw new Error("Podman runner exited without a result");
					}),
				]);
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch (error) {
					throw new Error("Podman runner returned invalid JSON", { cause: error });
				}
				const parsed = record(value, "runner result") as JsonValue;
				await this.#assertContainerRunning(containerName);
				await this.#copyContainerOutputs(containerName, mounts.outputRoot);
				return parsed;
			} finally {
				try {
					await remove();
				} finally {
					await modelSocket?.close();
				}
			}
		})();
		return {
			result,
			terminate: async () => {
				let removalError: unknown;
				try {
					await remove();
				} catch (error) {
					removalError = error;
				} finally {
					container.terminateClient();
					await result.catch(() => undefined);
				}
				if (removalError) throw removalError;
			},
		};
	}

	async #ensureRuntime(): Promise<void> {
		if (this.#commands.platform !== "linux") {
			throw new Error("Rootless Podman runner requires a Linux worker host");
		}
		if (!this.#runtimeReady) {
			const pending = this.#verifyRuntime();
			this.#runtimeReady = pending;
			pending.catch(() => {
				if (this.#runtimeReady === pending) this.#runtimeReady = undefined;
			});
		}
		await this.#runtimeReady;
	}

	async #verifyRuntime(): Promise<void> {
		const processHandle = this.#commands.start(this.#podmanPath, ["info", "--format", "json"], "", {
			stdoutBytes: MAX_PODMAN_INFO_BYTES,
			stderrBytes: MAX_COMMAND_STDERR_BYTES,
			timeoutMs: 10_000,
		});
		const result = await processHandle.completion;
		commandSucceeded(result, "Podman runtime inspection");
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error("Podman runtime inspection returned invalid JSON", { cause: error });
		}
		const info = record(parsed, "runtime information");
		const host = record(info.host, "host information");
		const security = record(host.security, "host security information");
		const version = record(info.version, "version information");
		const versionMatch = typeof version.Version === "string" ? /^(\d+)\.(\d+)\./.exec(version.Version) : null;
		if (
			host.os !== "linux" ||
			host.serviceIsRemote !== false ||
			host.cgroupVersion !== "v2" ||
			security.rootless !== true ||
			security.seccompEnabled !== true ||
			!versionMatch ||
			Number(versionMatch[1]) < 5
		) {
			throw new Error("Podman runtime does not satisfy the rootless isolation baseline");
		}
		await this.#sweepContainers();
		await this.#pruneTemporaryRoot();
	}

	async #sweepContainers(): Promise<void> {
		const processHandle = this.#commands.start(
			this.#podmanPath,
			[
				"ps",
				"--all",
				"--filter",
				"name=^qorpera-job-",
				"--filter",
				"label=io.qorpera.ephemeral-runner=true",
				"--format",
				"{{.Names}}",
			],
			"",
			{ stdoutBytes: 256 * 1024, stderrBytes: MAX_COMMAND_STDERR_BYTES, timeoutMs: 15_000 },
		);
		const result = await processHandle.completion;
		commandSucceeded(result, "Podman stale-container inspection");
		// Remove only names this backend provably created (exact UUID shape and
		// the runner label). A foreign same-prefix container must not brick the
		// sweep or be destroyed — it simply stays behind for the operator.
		const names = [
			...new Set(
				result.stdout
					.split(/\r?\n/)
					.map((name) => name.trim())
					.filter((name) => STALE_CONTAINER_NAME_PATTERN.test(name)),
			),
		];
		if (names.length === 0) return;
		const removal = this.#commands.start(this.#podmanPath, ["rm", "--force", "--time=0", ...names], "", {
			stdoutBytes: 256 * 1024,
			stderrBytes: MAX_COMMAND_STDERR_BYTES,
			timeoutMs: 60_000,
		});
		commandSucceeded(await removal.completion, "Podman stale-container destruction");
	}

	async #pruneTemporaryRoot(): Promise<void> {
		if (!this.#temporaryRoot) return;
		const root = await realpath(this.#temporaryRoot);
		const rootMetadata = await lstat(root);
		if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
			throw new Error("Podman temporary root is invalid");
		}
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!STALE_WORKSPACE_NAME_PATTERN.test(entry.name)) continue;
			const target = join(root, entry.name);
			const targetMetadata = await lstat(target);
			if (!entry.isDirectory() || !targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
				throw new Error("Podman stale workspace is invalid");
			}
			if (dirname(await realpath(target)) !== root) throw new Error("Podman stale workspace escapes its root");
			await rm(target, { recursive: true, force: false });
		}
	}

	async #copyContainerOutputs(containerName: string, outputRoot: string): Promise<void> {
		const processHandle = this.#commands.start(
			this.#podmanPath,
			["cp", "--archive=false", `${containerName}:${CONTAINER_PATHS.outputRoot}/.`, outputRoot],
			"",
			{ stdoutBytes: 4096, stderrBytes: MAX_COMMAND_STDERR_BYTES, timeoutMs: 60_000 },
		);
		const result = await processHandle.completion;
		commandSucceeded(result, "Podman output extraction");
	}

	async #assertContainerRunning(containerName: string): Promise<void> {
		const processHandle = this.#commands.start(
			this.#podmanPath,
			["inspect", "--format", "{{.State.Running}}", containerName],
			"",
			{ stdoutBytes: 16, stderrBytes: MAX_COMMAND_STDERR_BYTES, timeoutMs: 5000 },
		);
		const result = await processHandle.completion;
		commandSucceeded(result, "Podman output-boundary inspection");
		if (result.stdout.trim() !== "true") throw new Error("Podman runner exited before output extraction");
	}

	async #removeContainer(containerName: string): Promise<void> {
		const processHandle = this.#commands.start(
			this.#podmanPath,
			["rm", "--force", "--time=0", "--ignore", containerName],
			"",
			{ stdoutBytes: 4096, stderrBytes: MAX_COMMAND_STDERR_BYTES, timeoutMs: 15_000 },
		);
		const result = await processHandle.completion;
		commandSucceeded(result, "Podman container destruction");
	}
}
