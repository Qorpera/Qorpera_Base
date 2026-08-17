import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudRunnerModelSocketFactory } from "../src/cloud-runner-model-socket.ts";
import {
	NodePodmanCommandTransport,
	type PodmanCommandLimits,
	type PodmanCommandProcess,
	type PodmanCommandResult,
	type PodmanCommandTransport,
	RootlessPodmanSandboxBackend,
} from "../src/cloud-runner-podman.ts";
import type { CloudRunnerSandboxRequest } from "../src/cloud-runner-sandbox.ts";

const jobId = "77777777-7777-4777-8777-777777777777";
const versionId = "66666666-6666-4666-8666-666666666666";
const image = `registry.qorpera.test/runner@sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

function commandResult(stdout = "", exitCode = 0, stderr = ""): PodmanCommandResult {
	return { exitCode, stdout, stderr };
}

function completed(result: PodmanCommandResult): PodmanCommandProcess {
	const newline = result.stdout.indexOf("\n");
	return {
		completion: Promise.resolve(result),
		firstStdoutLine:
			newline < 0 ? new Promise<string>(() => undefined) : Promise.resolve(result.stdout.slice(0, newline)),
		terminateClient: () => undefined,
	};
}

class DeferredCommand implements PodmanCommandProcess {
	readonly completion: Promise<PodmanCommandResult>;
	readonly firstStdoutLine = new Promise<string>(() => undefined);
	#reject?: (error: Error) => void;
	terminateCalls = 0;

	constructor() {
		this.completion = new Promise((_resolve, reject) => {
			this.#reject = reject;
		});
	}

	terminateClient(): void {
		this.terminateCalls++;
		this.#reject?.(new Error("Podman client terminated"));
	}
}

interface CapturedCommand {
	executable: string;
	args: readonly string[];
	input: string;
	limits: PodmanCommandLimits;
}

class FakePodmanCommands implements PodmanCommandTransport {
	readonly platform: NodeJS.Platform = "linux";
	readonly calls: CapturedCommand[] = [];
	readonly responses: PodmanCommandProcess[] = [];

	start(
		executable: string,
		args: readonly string[],
		input: string,
		limits: PodmanCommandLimits,
	): PodmanCommandProcess {
		this.calls.push({ executable, args: [...args], input, limits: { ...limits } });
		const response = this.responses.shift();
		if (!response) throw new Error("Unexpected Podman command");
		return response;
	}
}

function runtimeInfo(rootless = true): string {
	return JSON.stringify({
		host: {
			os: "linux",
			serviceIsRemote: false,
			cgroupVersion: "v2",
			security: { rootless, seccompEnabled: true },
		},
		version: { Version: "5.6.1" },
	});
}

async function sandboxRequest(): Promise<CloudRunnerSandboxRequest> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-podman-test-"));
	temporaryDirectories.push(root);
	const inputRoot = join(root, "input");
	const companyRoot = join(inputRoot, "company");
	const artifactsRoot = join(inputRoot, "artifacts");
	const outputRoot = join(root, "output");
	await mkdir(inputRoot, { recursive: true });
	await Promise.all([
		mkdir(companyRoot, { recursive: true }),
		mkdir(artifactsRoot, { recursive: true }),
		mkdir(outputRoot, { recursive: true }),
		writeFile(join(inputRoot, "substrate.json"), "{}\n", "utf-8"),
		writeFile(join(inputRoot, "operations.jsonl"), "", "utf-8"),
	]);
	return {
		job: {
			jobId,
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: { prompt: "private founder request" },
		},
		substrate: {
			versionId,
			contentSha256: "b".repeat(64),
			operationSequence: 4,
			operationCount: 4,
			artifactCount: 2,
		},
		input: {
			companyRoot,
			substrateManifestPath: join(inputRoot, "substrate.json"),
			operationsPath: join(inputRoot, "operations.jsonl"),
			artifactsRoot,
		},
		outputRoot,
		environment: { QORPERA_JOB_MODE: "ephemeral" },
		limits: {
			wallTimeMs: 60_000,
			memoryBytes: 512 * 1024 * 1024,
			cpuCount: 1.5,
			maxPids: 64,
			maxInputBytes: 1024 * 1024,
			maxOutputBytes: 1024 * 1024,
			maxResultBytes: 4096,
		},
	};
}

function backend(
	commands: PodmanCommandTransport,
	modelSocketFactory?: CloudRunnerModelSocketFactory,
	temporaryRoot?: string,
): RootlessPodmanSandboxBackend {
	return new RootlessPodmanSandboxBackend({
		image,
		capabilities: ["agent_turn"],
		jobTypes: ["agent_turn"],
		commandTransport: commands,
		...(modelSocketFactory ? { modelSocketFactory } : {}),
		...(temporaryRoot ? { temporaryRoot } : {}),
	});
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("rootless Podman cloud runner", () => {
	it("starts a digest-pinned, networkless, resource-limited container and destroys it", async () => {
		const request = await sandboxRequest();
		const commands = new FakePodmanCommands();
		commands.responses.push(
			completed(commandResult(runtimeInfo())),
			completed(commandResult()),
			completed(commandResult('{"status":"ok"}\n')),
			completed(commandResult("true\n")),
			completed(commandResult()),
			completed(commandResult()),
		);
		const processHandle = await backend(commands).start(request);

		await expect(processHandle.result).resolves.toEqual({ status: "ok" });
		expect(commands.calls).toHaveLength(6);
		expect(commands.calls[0]?.args).toEqual(["info", "--format", "json"]);
		expect(commands.calls[1]?.args).toEqual([
			"ps",
			"--all",
			"--filter",
			"name=^qorpera-job-",
			"--format",
			"{{.Names}}",
		]);
		const run = commands.calls[2] as CapturedCommand;
		expect(run.executable).toBe("/usr/bin/podman");
		expect(run.args).toEqual(
			expect.arrayContaining([
				"run",
				"--label",
				"io.qorpera.ephemeral-runner=true",
				"--pull=never",
				"--network=none",
				"--read-only",
				"--read-only-tmpfs=false",
				"--image-volume=ignore",
				"--cap-drop=all",
				"--security-opt=no-new-privileges",
				"--userns=keep-id:size=1024",
				"--unsetenv-all",
				"--log-driver=none",
				"--timeout",
				"60",
				"QORPERA_JOB_MODE=ephemeral",
				image,
			]),
		);
		expect(run.args).not.toContain("--rm");
		expect(run.args).toContain(
			"type=tmpfs,destination=/qorpera/output,tmpfs-size=2097152,tmpfs-mode=0700,notmpcopyup",
		);
		expect(run.args.join(" ")).not.toContain(`src=${request.outputRoot},dst=/qorpera/output`);
		expect(run.args.join(" ")).not.toContain("private founder request");
		expect(JSON.parse(run.input) as JsonValue).toMatchObject({
			schema: "qorpera.ephemeral-container-request/v1",
			job: { jobId, payload: { prompt: "private founder request" } },
			paths: { companyRoot: "/qorpera/input/company", outputRoot: "/qorpera/output" },
		});
		expect(run.limits).toEqual({ stdoutBytes: 4097, stderrBytes: 16 * 1024, timeoutMs: 90_000 });
		expect(commands.calls[3]?.args).toEqual([
			"inspect",
			"--format",
			"{{.State.Running}}",
			expect.stringMatching(/^qorpera-job-[0-9a-f-]{36}$/),
		]);
		expect(commands.calls[4]?.args).toEqual([
			"cp",
			"--archive=false",
			expect.stringMatching(/^qorpera-job-[0-9a-f-]{36}:\/qorpera\/output\/\.$/),
			request.outputRoot,
		]);
		expect(commands.calls[5]?.args).toEqual([
			"rm",
			"--force",
			"--time=0",
			"--ignore",
			expect.stringMatching(/^qorpera-job-[0-9a-f-]{36}$/),
		]);
	});

	it("force-removes the container before cancellation completes", async () => {
		const request = await sandboxRequest();
		const commands = new FakePodmanCommands();
		const running = new DeferredCommand();
		commands.responses.push(
			completed(commandResult(runtimeInfo())),
			completed(commandResult()),
			running,
			completed(commandResult()),
		);
		const processHandle = await backend(commands).start(request);

		await expect(processHandle.terminate("cancelled")).resolves.toBeUndefined();
		expect(running.terminateCalls).toBe(1);
		expect(commands.calls[3]?.args.slice(0, 4)).toEqual(["rm", "--force", "--time=0", "--ignore"]);
		await expect(processHandle.result).rejects.toThrow("Podman client terminated");
	});

	it("mounts a job-private model socket without serializing host credentials and closes it with the container", async () => {
		const request = await sandboxRequest();
		const brokerRoot = join(request.outputRoot, "..", "broker");
		await mkdir(brokerRoot);
		const modelBroker = {
			requestModel: vi.fn(async () => {
				throw new Error("not called by the command boundary test");
			}),
		};
		request.hostBroker = { root: brokerRoot, model: modelBroker };
		const commands = new FakePodmanCommands();
		commands.responses.push(
			completed(commandResult(runtimeInfo())),
			completed(commandResult()),
			completed(commandResult('{"status":"ok"}\n')),
			completed(commandResult("true\n")),
			completed(commandResult()),
			completed(commandResult()),
		);
		const close = vi.fn(async () => undefined);
		const modelSocketFactory = vi.fn(async (options: Parameters<CloudRunnerModelSocketFactory>[0]) => ({
			socketPath: options.socketPath,
			close,
		}));

		const processHandle = await backend(commands, modelSocketFactory).start(request);
		await expect(processHandle.result).resolves.toEqual({ status: "ok" });

		expect(modelSocketFactory).toHaveBeenCalledWith({
			socketPath: join(brokerRoot, "model.sock"),
			broker: modelBroker,
		});
		const run = commands.calls[2] as CapturedCommand;
		expect(run.args).toContain(
			`type=bind,src=${brokerRoot},dst=/qorpera/broker,ro=true,relabel=private,bind-propagation=rprivate,bind-nonrecursive`,
		);
		expect(JSON.parse(run.input)).toMatchObject({ paths: { modelBrokerSocket: "/qorpera/broker/model.sock" } });
		expect(run.input).not.toContain("credential");
		expect(close).toHaveBeenCalledOnce();
	});

	it("removes only owned stale containers and workspaces during startup", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "qorpera-podman-cleanup-test-"));
		temporaryDirectories.push(temporaryRoot);
		const staleWorkspace = join(temporaryRoot, "qorpera-runner-AbC123");
		const unrelatedWorkspace = join(temporaryRoot, "keep-me");
		await Promise.all([mkdir(staleWorkspace), mkdir(unrelatedWorkspace)]);
		const staleContainer = "qorpera-job-11111111-1111-4111-8111-111111111111";
		const commands = new FakePodmanCommands();
		commands.responses.push(
			completed(commandResult(runtimeInfo())),
			completed(commandResult(`${staleContainer}\n`)),
			completed(commandResult()),
		);

		await backend(commands, undefined, temporaryRoot).prepare();

		expect(commands.calls[2]?.args).toEqual(["rm", "--force", "--time=0", staleContainer]);
		await expect(stat(staleWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await stat(unrelatedWorkspace)).isDirectory()).toBe(true);
	});

	it("refuses a rootful or remote-incompatible runtime before creating a container", async () => {
		const request = await sandboxRequest();
		const commands = new FakePodmanCommands();
		commands.responses.push(completed(commandResult(runtimeInfo(false))));

		await expect(backend(commands).start(request)).rejects.toThrow("rootless isolation baseline");
		expect(commands.calls).toHaveLength(1);
	});

	it("refuses mutable image references", () => {
		const commands = new FakePodmanCommands();
		expect(
			() =>
				new RootlessPodmanSandboxBackend({
					image: "registry.qorpera.test/runner:latest",
					capabilities: ["agent_turn"],
					jobTypes: ["agent_turn"],
					commandTransport: commands,
				}),
		).toThrow("pinned by SHA-256 digest");
	});

	it("rejects invalid resource ranges before invoking Podman", async () => {
		const valid = await sandboxRequest();
		const request = { ...valid, limits: { ...valid.limits, maxOutputBytes: -1 } };
		const commands = new FakePodmanCommands();

		await expect(backend(commands).start(request)).rejects.toThrow("sandbox request is invalid");
		expect(commands.calls).toHaveLength(0);
	});

	it("bounds subprocess output before it can exhaust the worker", async () => {
		const environment: NodeJS.ProcessEnv = {};
		if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
		const commands = new NodePodmanCommandTransport(environment);
		const processHandle = commands.start(process.execPath, ["-e", "process.stdout.write('12345')"], "", {
			stdoutBytes: 4,
			stderrBytes: 1024,
			timeoutMs: 1000,
		});
		await expect(processHandle.completion).rejects.toThrow("stdout exceeded its byte limit");
	});

	it("bounds a stuck host command independently of the container deadline", async () => {
		const environment: NodeJS.ProcessEnv = {};
		if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
		const commands = new NodePodmanCommandTransport(environment);
		const processHandle = commands.start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", {
			stdoutBytes: 1024,
			stderrBytes: 1024,
			timeoutMs: 20,
		});
		await expect(processHandle.completion).rejects.toThrow("wall-time limit");
	});

	it("exposes the first result line while the container process remains alive", async () => {
		const environment: NodeJS.ProcessEnv = {};
		if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
		const commands = new NodePodmanCommandTransport(environment);
		const processHandle = commands.start(
			process.execPath,
			["-e", 'process.stdout.write(\'{\\"status\\":\\"ok\\"}\\n\'); setInterval(() => {}, 1000)'],
			"",
			{ stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 },
		);
		await expect(processHandle.firstStdoutLine).resolves.toBe('{"status":"ok"}');
		processHandle.terminateClient();
		await processHandle.completion.catch(() => undefined);
	});
});
