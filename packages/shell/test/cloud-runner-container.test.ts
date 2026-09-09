import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudRunnerContainerJob } from "@qorpera/runtime/cloud-runner-container";
import { readCloudRunnerContainerRequest } from "@qorpera/runtime/cloud-runner-container-main";
import { startCloudRunnerModelSocketServer } from "@qorpera/runtime/cloud-runner-model-socket";
import { afterEach, describe, expect, it } from "vitest";

const jobId = "77777777-7777-4777-8777-777777777777";
const versionId = "66666666-6666-4666-8666-666666666666";
const contentSha256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

async function layout(): Promise<{
	companyBaseRoot: string;
	companyRoot: string;
	substrateManifestPath: string;
	operationsPath: string;
	artifactsRoot: string;
	outputRoot: string;
}> {
	const root = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-container-contract-test-"));
	temporaryDirectories.push(root);
	const input = join(root, "input");
	const companyBaseRoot = join(input, "company");
	const companyRoot = join(root, "work", "company");
	const artifactsRoot = join(input, "artifacts");
	const outputRoot = join(root, "output");
	await Promise.all([
		mkdir(companyBaseRoot, { recursive: true }),
		mkdir(companyRoot, { recursive: true }),
		mkdir(artifactsRoot, { recursive: true }),
		mkdir(outputRoot),
	]);
	const substrateManifestPath = join(input, "substrate.json");
	const operationsPath = join(input, "operations.jsonl");
	await Promise.all([
		writeFile(
			substrateManifestPath,
			`${JSON.stringify({
				schema: "qorpera.runner-input/v1",
				versionId,
				contentSha256,
				operationCount: 1,
				artifactCount: 0,
			})}\n`,
		),
		writeFile(operationsPath, '{"sequence":1}\n'),
		writeFile(join(artifactsRoot, "index.json"), "[]\n"),
	]);
	return { companyBaseRoot, companyRoot, substrateManifestPath, operationsPath, artifactsRoot, outputRoot };
}

function request(): Record<string, unknown> {
	return {
		schema: "qorpera.ephemeral-container-request/v1",
		job: {
			jobId,
			jobType: "sandbox_probe",
			requiredCapability: "company_substrate",
			attemptCount: 1,
			payload: {},
		},
		substrate: { versionId, contentSha256, operationSequence: 1, operationCount: 1, artifactCount: 0 },
		paths: {
			companyBaseRoot: "/qorpera/input/company",
			companyRoot: "/qorpera/work/company",
			substrateManifestPath: "/qorpera/input/substrate.json",
			operationsPath: "/qorpera/input/operations.jsonl",
			artifactsRoot: "/qorpera/input/artifacts",
			outputRoot: "/qorpera/output",
		},
		limits: { maxResultBytes: 4096, memoryBytes: 512 * 1024 * 1024, cpuCount: 1, maxPids: 64 },
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud runner container contract", () => {
	it("probes immutable input and writes only a bounded output proof", async () => {
		const hostPaths = await layout();
		await expect(runCloudRunnerContainerJob(request(), hostPaths)).resolves.toEqual({
			schema: "qorpera.sandbox-probe-result/v1",
			status: "ok",
			job_id: jobId,
			substrate_version_id: versionId,
			proof_path: "sandbox-proof.json",
		});
		const proof = JSON.parse(await readFile(join(hostPaths.outputRoot, "sandbox-proof.json"), "utf-8"));
		expect(proof).toMatchObject({
			schema: "qorpera.sandbox-probe-proof/v1",
			job_id: jobId,
			company_mounted: true,
			artifact_index_bytes: 3,
		});
	});

	it("rejects a mutable substrate mismatch", async () => {
		const hostPaths = await layout();
		const inconsistent = request();
		inconsistent.substrate = { versionId, contentSha256: "b".repeat(64), operationCount: 1, artifactCount: 0 };
		await expect(runCloudRunnerContainerJob(inconsistent, hostPaths)).rejects.toThrow("immutable job input");
	});

	it("detects a writable input when the live containment assertion is requested", async () => {
		const hostPaths = await layout();
		const value = request();
		value.job = {
			jobId,
			jobType: "sandbox_probe",
			requiredCapability: "company_substrate",
			attemptCount: 1,
			payload: { assertions: { input_read_only: true, company_checkout_writable: true } },
		};
		await expect(runCloudRunnerContainerJob(value, hostPaths)).rejects.toThrow("Container input is writable");
	});

	it.runIf(process.platform !== "win32")(
		"proves the container-side client can use only the bounded model socket",
		async () => {
			const hostPaths = await layout();
			const requestId = "34343434-3434-4434-8434-343434343434";
			/* The layout root resolves under /private/var/folders, which is too
			 * long for the portable Unix socket limit; the socket gets its own
			 * short-lived directory under /tmp instead. */
			const socketRoot = await mkdtemp(join(realpathSync("/tmp"), "q-sock-"));
			temporaryDirectories.push(socketRoot);
			const socketPath = join(socketRoot, "model.sock");
			const modelSocket = await startCloudRunnerModelSocketServer({
				socketPath,
				broker: {
					requestModel: async (input) => ({
						requestId: input.requestId,
						provider: input.provider,
						model: input.model,
						output: { text: "networkless broker proof" },
						usage: { inputTokens: 3, outputTokens: 2, costMicrousd: 11 },
					}),
				},
			});
			const value = request();
			value.paths = {
				...(value.paths as Record<string, unknown>),
				modelBrokerSocket: "/qorpera/broker/model.sock",
			};
			value.job = {
				jobId,
				jobType: "sandbox_probe",
				requiredCapability: "company_substrate",
				attemptCount: 1,
				payload: {
					assertions: { model_broker: true },
					model_request: {
						request_id: requestId,
						provider: "openai",
						model: "gpt-test",
						input: { prompt: "socket proof" },
						max_output_tokens: 8,
					},
				},
			};

			try {
				await runCloudRunnerContainerJob(value, { ...hostPaths, modelBrokerSocket: socketPath });
				const proof = JSON.parse(await readFile(join(hostPaths.outputRoot, "sandbox-proof.json"), "utf-8"));
				expect(proof).toMatchObject({ model_broker: true, network_isolated: null });
			} finally {
				await modelSocket.close();
			}
		},
	);

	it("bounds stdin before parsing JSON", async () => {
		async function* oversized(): AsyncGenerator<Uint8Array> {
			yield Buffer.alloc(128 * 1024);
			yield Buffer.from("x");
		}
		await expect(readCloudRunnerContainerRequest(oversized())).rejects.toThrow("byte limit");
	});
});
