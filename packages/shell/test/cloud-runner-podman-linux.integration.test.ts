import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RootlessPodmanSandboxBackend } from "../src/cloud-runner-podman.ts";
import type { CloudRunnerSandboxRequest } from "../src/cloud-runner-sandbox.ts";

const image = process.env.QORPERA_LINUX_RUNNER_IMAGE;
const podmanPath = process.env.QORPERA_LINUX_PODMAN_PATH ?? "/usr/bin/podman";
const enabled = process.platform === "linux" && typeof image === "string" && image.length > 0;
const jobId = "77777777-7777-4777-8777-777777777777";
const versionId = "66666666-6666-4666-8666-666666666666";
const contentSha256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

async function request(): Promise<CloudRunnerSandboxRequest> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-podman-linux-test-"));
	temporaryDirectories.push(root);
	const inputRoot = join(root, "input");
	const companyRoot = join(inputRoot, "company");
	const artifactsRoot = join(inputRoot, "artifacts");
	const outputRoot = join(root, "output");
	await Promise.all([
		mkdir(companyRoot, { recursive: true }),
		mkdir(artifactsRoot, { recursive: true }),
		mkdir(outputRoot),
	]);
	const substrateManifestPath = join(inputRoot, "substrate.json");
	const operationsPath = join(inputRoot, "operations.jsonl");
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
			{ mode: 0o400 },
		),
		writeFile(operationsPath, '{"sequence":1}\n', { mode: 0o400 }),
		writeFile(join(artifactsRoot, "index.json"), "[]\n", { mode: 0o400 }),
	]);
	return {
		job: {
			jobId,
			jobType: "sandbox_probe",
			requiredCapability: "company_substrate",
			attemptCount: 1,
			payload: {
				assertions: {
					input_read_only: true,
					root_read_only: true,
					network_isolated: true,
					resource_limits: true,
				},
			},
		},
		substrate: { versionId, contentSha256, operationSequence: 1, operationCount: 1, artifactCount: 0 },
		input: { companyRoot, substrateManifestPath, operationsPath, artifactsRoot },
		outputRoot,
		environment: { QORPERA_JOB_MODE: "ephemeral" },
		limits: {
			wallTimeMs: 30_000,
			memoryBytes: 512 * 1024 * 1024,
			cpuCount: 0.5,
			maxPids: 64,
			maxInputBytes: 1024 * 1024,
			maxOutputBytes: 1024 * 1024,
			maxResultBytes: 4096,
		},
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!enabled)("rootless Podman Linux boundary", () => {
	it("enforces the real image, mount, network, cgroup, and destruction contract", async () => {
		if (!image) throw new Error("QORPERA_LINUX_RUNNER_IMAGE is required");
		const sandboxRequest = await request();
		const backend = new RootlessPodmanSandboxBackend({
			image,
			capabilities: ["company_substrate"],
			jobTypes: ["sandbox_probe"],
			podmanPath,
		});
		const processHandle = await backend.start(sandboxRequest);
		await expect(processHandle.result).resolves.toEqual({
			schema: "qorpera.sandbox-probe-result/v1",
			status: "ok",
			job_id: jobId,
			substrate_version_id: versionId,
			proof_path: "sandbox-proof.json",
		});
		const proof = JSON.parse(await readFile(join(sandboxRequest.outputRoot, "sandbox-proof.json"), "utf-8"));
		expect(proof).toMatchObject({
			input_read_only: true,
			root_read_only: true,
			network_isolated: true,
			resource_limits: true,
		});
		const retained = execFileSync(
			podmanPath,
			["ps", "--all", "--filter", "name=qorpera-job-", "--format", "{{.Names}}"],
			{
				encoding: "utf-8",
			},
		);
		expect(retained.trim()).toBe("");
	});
});
