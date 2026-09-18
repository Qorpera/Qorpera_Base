import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadEphemeralCloudRunnerServiceConfig,
	parseEphemeralCloudRunnerServiceConfig,
	runEphemeralCloudRunnerService,
} from "@qorpera/runtime/cloud-runner-service";
import {
	safeCloudRunnerServiceError,
	withCloudRunnerShutdownSignals,
} from "@qorpera/runtime/cloud-runner-service-main";
import { afterEach, describe, expect, it } from "vitest";

const runnerId = "77777777-7777-4777-8777-777777777777";
const activationToken = "a".repeat(43);
const repairToken = "b".repeat(43);
const image = `registry.qorpera.test/runner@sha256:${"b".repeat(64)}`;
const temporaryDirectories: string[] = [];

class FakeSignalHost {
	readonly #listeners = new Map<"SIGINT" | "SIGTERM", () => void>();

	once(event: "SIGINT" | "SIGTERM", listener: () => void): void {
		this.#listeners.set(event, listener);
	}

	removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void {
		if (this.#listeners.get(event) === listener) this.#listeners.delete(event);
	}

	emit(event: "SIGINT" | "SIGTERM"): void {
		this.#listeners.get(event)?.();
	}

	listenerCount(): number {
		return this.#listeners.size;
	}
}

async function serviceRoot(): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-runner-service-test-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, "tmp"));
	return root;
}

function configValue(root: string): Record<string, unknown> {
	return {
		schema: "qorpera.ephemeral-runner-service/v1",
		base_url: "https://qorpera.test",
		publishable_key: "sb_publishable_test",
		runner_id: runnerId,
		authority_state_path: join(root, "state", "authority.json"),
		temporary_root: join(root, "tmp"),
		image,
		podman_path: process.platform === "win32" ? "C:\\Program Files\\RedHat\\Podman\\podman.exe" : "/usr/bin/podman",
		entrypoint: "/qorpera/bin/run-job",
		capabilities: ["company_substrate"],
		job_types: ["sandbox_probe"],
		platform: "linux-x64",
		runner_version: "0.19.0",
		environment: { QORPERA_JOB_MODE: "ephemeral" },
		limits: { wall_time_ms: 60_000, memory_bytes: 512 * 1024 * 1024, cpu_count: 1, max_pids: 64 },
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ephemeral cloud runner service", () => {
	it("strictly loads deployment configuration", async () => {
		const root = await serviceRoot();
		const path = join(root, "config.json");
		await writeFile(path, `${JSON.stringify(configValue(root))}\n`, { encoding: "utf-8", mode: 0o600 });

		const config = await loadEphemeralCloudRunnerServiceConfig(path);
		expect(config).toMatchObject({
			schema: "qorpera.ephemeral-runner-service/v1",
			runnerId,
			image,
			capabilities: ["company_substrate"],
			jobTypes: ["sandbox_probe"],
			limits: { wallTimeMs: 60_000, memoryBytes: 512 * 1024 * 1024, cpuCount: 1, maxPids: 64 },
		});
	});

	it("rejects unknown settings and credential-shaped container environment", async () => {
		const root = await serviceRoot();
		expect(() => parseEphemeralCloudRunnerServiceConfig({ ...configValue(root), typo: true })).toThrow(
			"unknown setting",
		);
		expect(() =>
			parseEphemeralCloudRunnerServiceConfig({
				...configValue(root),
				environment: { MODEL_API_KEY: "must-not-cross-the-boundary" },
			}),
		).toThrow("invalid entry");
		expect(() =>
			parseEphemeralCloudRunnerServiceConfig({
				...configValue(root),
				native_bridge_url: "http://127.0.0.1:8082/",
			}),
		).toThrow("explicit production isolation boundary");
		expect(
			parseEphemeralCloudRunnerServiceConfig({
				...configValue(root),
				native_bridge_url: "http://127.0.0.1:8082/",
				native_bridge_boundary: "virtual_machine",
			}),
		).toMatchObject({
			nativeBridgeUrl: "http://127.0.0.1:8082/",
			nativeBridgeBoundary: "virtual_machine",
		});
		expect(() =>
			parseEphemeralCloudRunnerServiceConfig({
				...configValue(root),
				assignment_host: "0.0.0.0",
				assignment_port: 8082,
			}),
		).toThrow("trusted VM-network source");
		expect(
			parseEphemeralCloudRunnerServiceConfig({
				...configValue(root),
				assignment_host: "0.0.0.0",
				assignment_port: 8082,
				assignment_trusted_source: "10.41.0.1",
			}),
		).toMatchObject({
			assignmentHost: "0.0.0.0",
			assignmentPort: 8082,
			assignmentTrustedSource: "10.41.0.1",
		});
	});

	it("uses the systemd activation credential once, then restores authority without it", async () => {
		const root = await serviceRoot();
		const credentialsDirectory = join(root, "credentials");
		await mkdir(credentialsDirectory, { mode: 0o700 });
		await writeFile(join(credentialsDirectory, "qorpera-runner-activation"), `${activationToken}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		const config = parseEphemeralCloudRunnerServiceConfig(configValue(root));
		let starts = 0;
		const runWorker = async (): Promise<void> => {
			starts++;
		};

		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker,
		});
		await rm(join(credentialsDirectory, "qorpera-runner-activation"));
		await runEphemeralCloudRunnerService({
			config,
			signal: new AbortController().signal,
			runWorker,
		});

		expect(starts).toBe(2);
		const stored = JSON.parse(await readFile(config.authorityStatePath, "utf-8")) as Record<string, unknown>;
		expect(stored).toMatchObject({ schema: "qorpera.runner-authority/v3", runner_id: runnerId });
	});

	it("does not initialize authority without the one-time credential", async () => {
		const root = await serviceRoot();
		const config = parseEphemeralCloudRunnerServiceConfig(configValue(root));
		await expect(
			runEphemeralCloudRunnerService({
				config,
				signal: new AbortController().signal,
				runWorker: async () => undefined,
			}),
		).rejects.toThrow("required for initial setup");
	});

	it("replaces expired session state only when an explicit repair credential is present", async () => {
		const root = await serviceRoot();
		const credentialsDirectory = join(root, "credentials");
		await mkdir(credentialsDirectory, { mode: 0o700 });
		await writeFile(join(credentialsDirectory, "qorpera-runner-activation"), `${activationToken}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		const config = parseEphemeralCloudRunnerServiceConfig(configValue(root));
		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker: async () => undefined,
		});
		await rm(join(credentialsDirectory, "qorpera-runner-activation"));
		await writeFile(join(credentialsDirectory, "qorpera-runner-repair"), `${repairToken}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});

		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker: async () => undefined,
		});

		const stored = JSON.parse(await readFile(config.authorityStatePath, "utf-8")) as Record<string, unknown>;
		expect(stored).toMatchObject({
			schema: "qorpera.runner-authority/v3",
			runner_id: runnerId,
			activation_token: repairToken,
			session_token: null,
			leases: [],
			consumed_repair_sha256: createHash("sha256").update(repairToken).digest("hex"),
		});
	});

	it("does not wipe repaired authority again while the consumed repair credential lingers", async () => {
		const root = await serviceRoot();
		const credentialsDirectory = join(root, "credentials");
		await mkdir(credentialsDirectory, { mode: 0o700 });
		await writeFile(join(credentialsDirectory, "qorpera-runner-activation"), `${activationToken}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		const config = parseEphemeralCloudRunnerServiceConfig(configValue(root));
		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker: async () => undefined,
		});
		await rm(join(credentialsDirectory, "qorpera-runner-activation"));
		await writeFile(join(credentialsDirectory, "qorpera-runner-repair"), `${repairToken}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker: async () => undefined,
		});

		// Simulate a crash between activation staging and completion: the staged
		// replay token must survive the next boot even though the consumed repair
		// credential file was never deleted.
		const stagedReplayToken = "c".repeat(43);
		const stored = JSON.parse(await readFile(config.authorityStatePath, "utf-8")) as Record<string, unknown>;
		stored.pending_activation_token = stagedReplayToken;
		await writeFile(config.authorityStatePath, `${JSON.stringify(stored)}\n`, { encoding: "utf-8", mode: 0o600 });

		await runEphemeralCloudRunnerService({
			config,
			credentialsDirectory,
			signal: new AbortController().signal,
			runWorker: async () => undefined,
		});
		const after = JSON.parse(await readFile(config.authorityStatePath, "utf-8")) as Record<string, unknown>;
		expect(after).toMatchObject({
			activation_token: repairToken,
			pending_activation_token: stagedReplayToken,
			consumed_repair_sha256: createHash("sha256").update(repairToken).digest("hex"),
		});
	});

	it("turns SIGTERM into cooperative cancellation and removes listeners", async () => {
		const host = new FakeSignalHost();
		let observedAbort = false;
		const running = withCloudRunnerShutdownSignals(
			(signal) =>
				new Promise<void>((resolveRun) => {
					signal.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							resolveRun();
						},
						{ once: true },
					);
				}),
			host,
		);
		host.emit("SIGTERM");
		await running;
		expect(observedAbort).toBe(true);
		expect(host.listenerCount()).toBe(0);
	});

	it("redacts activation-shaped credentials from fatal errors", () => {
		expect(safeCloudRunnerServiceError(new Error(`failed for ${activationToken}`))).toBe("failed for [redacted]");
	});
});
