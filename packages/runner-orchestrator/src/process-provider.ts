import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { ServiceHttpFetch } from "./http-transport.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";
import type { CloudRunnerProviderServiceBackend } from "./provider-service.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const RUNTIME_START_TIMEOUT_MS = 30_000;

function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

export interface ProcessCloudRunnerProviderConfig {
	adapterId: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	supabasePublishableKey: string;
	runnerModulePath: string;
	nativeProviderModulePath: string;
	stateRoot: string;
	temporaryRoot: string;
	image: string;
	podmanPath: string;
	entrypoint: string;
	nativeProviderMasterKeyFile: string;
	nativeExecutionBoundary: "virtual_machine" | "microvm";
	codexPath: string;
	claudePath: string;
	platform: string;
	runnerVersion: string;
}

interface ProcessRuntime {
	acquisitionId: string;
	runner: CloudRunnerInstance;
	work: CloudRunnerWork;
	assignmentToken: string;
	port: number;
	child: ChildProcess;
	exit: Promise<void>;
	nativeChild: ChildProcess;
	nativeExit: Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

async function privateToken(path: string): Promise<string> {
	try {
		const existing = (await readFile(path, "utf-8")).trim();
		if (!TOKEN_PATTERN.test(existing)) throw new Error("Stored provider credential is invalid");
		return existing;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		const value = token();
		await writeFile(path, `${value}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		return value;
	}
}

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not reserve a runner assignment port");
	await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
	return address.port;
}

function exactRunner(value: unknown, work: CloudRunnerWork, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Provisioned runner");
	if (
		input.runner_kind !== "qorpera_computer" ||
		input.provider_adapter !== adapterId ||
		input.status === "revoked" ||
		input.compute_identity_id !== work.computeIdentityId ||
		input.logical_computer_id !== (work.logicalComputerId ?? null) ||
		input.worker_class !== work.workerClass ||
		input.template_key !== work.computeTemplateKey ||
		input.template_version !== work.computeTemplateVersion ||
		input.compute_policy_sha256 !== work.computePolicySha256 ||
		!Array.isArray(input.capabilities) ||
		!input.capabilities.includes(work.requiredCapability)
	) {
		throw new Error("Provisioned runner does not match immutable compute authority");
	}
	return {
		runnerId: uuid(input.runner_id, "Provisioned runner id"),
		...(work.logicalComputerId ? { logicalComputerId: work.logicalComputerId } : {}),
		...(work.computeIdentityId ? { computeIdentityId: work.computeIdentityId } : {}),
		workerClass: work.workerClass as "managed_sandbox" | "company_computer",
		providerAdapter: adapterId,
		capabilities: input.capabilities as CloudRunnerInstance["capabilities"],
		templateKey: work.computeTemplateKey as string,
		templateVersion: work.computeTemplateVersion as string,
		policySha256: work.computePolicySha256 as string,
	};
}

async function stopProcess(child: ChildProcess, exit: Promise<void>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return exit;
	child.kill("SIGTERM");
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolveWait) => {
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveWait();
		}, 10_000);
	});
	await Promise.race([exit, timeout]);
	if (timer) clearTimeout(timer);
}

async function stopRuntime(runtime: ProcessRuntime): Promise<void> {
	await stopProcess(runtime.child, runtime.exit);
	await stopProcess(runtime.nativeChild, runtime.nativeExit);
}

export class ProcessCloudRunnerProviderBackend implements CloudRunnerProviderServiceBackend {
	readonly adapterId: string;
	readonly #config: ProcessCloudRunnerProviderConfig;
	readonly #fetch: ServiceHttpFetch;
	readonly #runtimes = new Map<string, ProcessRuntime>();

	constructor(config: ProcessCloudRunnerProviderConfig, fetchImplementation: ServiceHttpFetch = fetch) {
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(config.adapterId)) throw new Error("Provider adapter id is invalid");
		for (const [label, path] of [
			["Runner module", config.runnerModulePath],
			["Native provider module", config.nativeProviderModulePath],
			["Provider state root", config.stateRoot],
			["Provider temporary root", config.temporaryRoot],
			["Provider Podman path", config.podmanPath],
			["Native provider master-key file", config.nativeProviderMasterKeyFile],
		] as const) {
			if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
		}
		if (
			(config.nativeExecutionBoundary !== "virtual_machine" && config.nativeExecutionBoundary !== "microvm") ||
			!IMAGE_PATTERN.test(config.image) ||
			!config.codexPath.trim() ||
			/[\0\r\n]/.test(config.codexPath) ||
			!config.claudePath.trim() ||
			/[\0\r\n]/.test(config.claudePath)
		) {
			throw new Error("Provider runner credentials or image are invalid");
		}
		this.adapterId = config.adapterId;
		this.#config = { ...config };
		this.#fetch = fetchImplementation;
	}

	async reconcile(_signal?: AbortSignal): Promise<void> {
		for (const [acquisitionId, runtime] of this.#runtimes) {
			if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
				await stopRuntime(runtime);
				this.#runtimes.delete(acquisitionId);
			}
		}
	}

	async close(): Promise<void> {
		const runtimes = [...this.#runtimes.values()];
		this.#runtimes.clear();
		await Promise.allSettled(runtimes.map((runtime) => stopRuntime(runtime)));
	}

	async acquire(acquisitionId: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		validateCloudRunnerWork(work);
		if (acquisitionId !== work.runId) throw new Error("Provider acquisition must use the immutable run id");
		if (!work.computeIdentityId) throw new Error("Native provider acquisition requires a Compute Identity");
		const current = this.#runtimes.get(acquisitionId);
		if (current && current.child.exitCode === null && current.child.signalCode === null) {
			if (JSON.stringify(current.work) !== JSON.stringify(work)) {
				throw new Error("Provider acquisition id is bound to another work request");
			}
			return current.runner;
		}
		if (current) {
			await stopRuntime(current);
			this.#runtimes.delete(acquisitionId);
		}
		if (this.#runtimes.size > 0) {
			throw new Error("Dedicated native provider machine is already running another acquisition");
		}
		const root = resolve(this.#config.stateRoot, acquisitionId);
		const credentials = join(root, "credentials");
		const runtimeTemporaryRoot = join(this.#config.temporaryRoot, acquisitionId);
		await mkdir(credentials, { recursive: true, mode: 0o700 });
		await mkdir(runtimeTemporaryRoot, { recursive: true, mode: 0o700 });
		await chmod(credentials, 0o700);
		const activationToken = await privateToken(join(credentials, "qorpera-runner-activation"));
		const assignmentToken = await privateToken(join(credentials, "qorpera-runner-assignment"));
		const nativeBridgeToken = await privateToken(join(credentials, "qorpera-native-bridge"));
		const runner = exactRunner(
			await this.#rpc(
				"qorpera_provision_execution_runner",
				{
					p_run_id: work.runId,
					p_client_runner_id: acquisitionId,
					p_provider_adapter: this.adapterId,
					p_activation_token_sha256: createHash("sha256").update(activationToken).digest("hex"),
				},
				signal,
			),
			work,
			this.adapterId,
		);
		const nativePort = await reserveLoopbackPort();
		const nativeTemporaryRoot = join(runtimeTemporaryRoot, "native");
		await mkdir(nativeTemporaryRoot, { recursive: true, mode: 0o700 });
		const nativeChild = spawn(process.execPath, [this.#config.nativeProviderModulePath], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				QORPERA_SUPABASE_URL: this.#config.supabaseUrl,
				// G2-5: the native host holds no service key (it refuses one).
				QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE: this.#config.nativeProviderMasterKeyFile,
				QORPERA_NATIVE_PROVIDER_BRIDGE_TOKEN: nativeBridgeToken,
				QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY: this.#config.nativeExecutionBoundary,
				QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID: work.computeIdentityId,
				QORPERA_NATIVE_PROVIDER_HOST: "127.0.0.1",
				QORPERA_NATIVE_PROVIDER_PORT: String(nativePort),
				QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT: nativeTemporaryRoot,
				QORPERA_CODEX_PATH: this.#config.codexPath,
				QORPERA_CLAUDE_PATH: this.#config.claudePath,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		const append = (chunk: Buffer): void => {
			output = `${output}${chunk.toString("utf-8")}`.slice(-16_384);
		};
		nativeChild.stdout?.on("data", append);
		nativeChild.stderr?.on("data", append);
		const nativeExit = new Promise<void>((resolveExit) => nativeChild.once("close", () => resolveExit()));
		try {
			const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (signal.aborted) throw signal.reason;
				if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) {
					throw new Error(`Native provider sidecar exited during startup: ${output.trim().slice(0, 1000)}`);
				}
				try {
					const response = await this.#fetch(`http://127.0.0.1:${nativePort}/healthz`, {
						signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
					});
					if (response.ok) break;
				} catch {
					// The native sidecar is still starting.
				}
				await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			}
			if (Date.now() >= deadline) throw new Error("Native provider sidecar did not become ready");
		} catch (error) {
			await stopProcess(nativeChild, nativeExit);
			throw error;
		}
		const port = await reserveLoopbackPort();
		const configPath = join(root, "runner-config.json");
		await writeFile(
			configPath,
			`${JSON.stringify(
				{
					schema: "qorpera.ephemeral-runner-service/v1",
					base_url: this.#config.supabaseUrl,
					publishable_key: this.#config.supabasePublishableKey,
					runner_id: runner.runnerId,
					authority_state_path: join(root, "runner-authority.json"),
					temporary_root: runtimeTemporaryRoot,
					image: this.#config.image,
					podman_path: this.#config.podmanPath,
					entrypoint: this.#config.entrypoint,
					capabilities: [...runner.capabilities],
					job_types: [work.jobType],
					platform: this.#config.platform,
					runner_version: this.#config.runnerVersion,
					native_bridge_url: `http://127.0.0.1:${nativePort}/`,
					native_bridge_boundary: this.#config.nativeExecutionBoundary,
					assignment_host: "127.0.0.1",
					assignment_port: port,
					max_assignments: 1,
					environment: {},
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		const child = spawn(process.execPath, [this.#config.runnerModulePath], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				QORPERA_RUNNER_CONFIG: configPath,
				CREDENTIALS_DIRECTORY: credentials,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const exit = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
		const runtime: ProcessRuntime = {
			acquisitionId,
			runner,
			work: structuredClone(work),
			assignmentToken,
			port,
			child,
			exit,
			nativeChild,
			nativeExit,
		};
		this.#runtimes.set(acquisitionId, runtime);
		try {
			const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (signal.aborted) throw signal.reason;
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(`Ephemeral runner exited during startup: ${output.trim().slice(0, 1000)}`);
				}
				try {
					const response = await this.#fetch(`http://127.0.0.1:${port}/healthz`, {
						signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
					});
					if (response.ok) return runner;
				} catch {
					// The runner activates before opening its loopback assignment inbox.
				}
				await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			}
			throw new Error("Ephemeral runner did not open its assignment inbox");
		} catch (error) {
			await stopRuntime(runtime);
			this.#runtimes.delete(acquisitionId);
			throw error;
		}
	}

	async deliver(
		runner: CloudRunnerInstance,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		const runtime = this.#runtimes.get(delivery.work.runId);
		if (
			!runtime ||
			runtime.runner.runnerId !== runner.runnerId ||
			runtime.runner.runnerId !== delivery.assignment.runnerId
		) {
			throw new Error("Ephemeral runner is unavailable for this assignment");
		}
		const response = await this.#fetch(`http://127.0.0.1:${runtime.port}/v1/assignment`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${runtime.assignmentToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				schema: "qorpera.runner-assignment-delivery/v1",
				assignment_id: delivery.assignment.assignmentId,
				job_id: delivery.assignment.jobId,
				capability: delivery.capability,
			}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
		if (response.status !== 200 && response.status !== 202) {
			throw new Error(`Ephemeral runner rejected assignment delivery (${response.status})`);
		}
	}

	async stop(
		runner: CloudRunnerInstance,
		_reason: "delivery_failed" | "idle" | "revoked",
		_signal?: AbortSignal,
	): Promise<void> {
		const runtime = [...this.#runtimes.values()].find((candidate) => candidate.runner.runnerId === runner.runnerId);
		if (!runtime) return;
		await stopRuntime(runtime);
		this.#runtimes.delete(runtime.acquisitionId);
	}

	async #rpc(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const response = await this.#fetch(new URL(`/rest/v1/rpc/${name}`, this.#config.supabaseUrl), {
			method: "POST",
			headers: {
				...supabaseServiceHeaders(this.#config.supabaseServiceKey),
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Runner provisioning failed (${response.status})`);
		return response.json() as Promise<unknown>;
	}
}
