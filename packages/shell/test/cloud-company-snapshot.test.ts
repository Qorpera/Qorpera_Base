import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureCloudCompanyTree,
	materializeCloudCompanyTree,
	verifyCloudCompanyTreeRestore,
} from "../src/cloud-company-snapshot.ts";
import {
	CloudCompanyWorkspaceState,
	type CompanyWorkspacePrimary,
	checkpointCloudCompanyWorkspace,
} from "../src/cloud-company-workspace.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-16T12:00:00.000Z";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();
	putCalls = 0;

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		this.putCalls++;
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-cloud-company-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function companyFixture(): Promise<string> {
	const root = join(await temporaryDirectory(), "company");
	scaffoldCompany(root);
	await writeFile(join(root, "company.md"), "# Shared company\n", "utf-8");
	await writeFile(join(root, "trail", "local.jsonl"), "private trail\n", "utf-8");
	await writeFile(join(root, ".qorpera", "staff.json"), "{}\n", "utf-8");
	await mkdir(join(root, "departments", "product", "repository"), { recursive: true });
	await writeFile(join(root, "departments", "product", "repository", "local.txt"), "checkout", "utf-8");
	await mkdir(join(root, "app", "tools", "example", "node_modules", "dependency"), { recursive: true });
	await writeFile(join(root, "app", "tools", "example", "node_modules", "dependency", "index.js"), "cache", "utf-8");
	await mkdir(join(root, "app", "substrates"), { recursive: true });
	await writeFile(join(root, "app", "substrates", "market.md"), "durable substrate\n", "utf-8");
	return root;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company snapshots", () => {
	it("captures a deterministic logical tree, deduplicates it, and materializes verified files", async () => {
		const root = await companyFixture();
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const first = await captureCloudCompanyTree(root, profileId, store);
		const objectCount = transport.objects.size;
		const second = await captureCloudCompanyTree(root, profileId, store);
		expect(second).toEqual(first);
		expect(transport.objects.size).toBe(objectCount);
		const restore = await verifyCloudCompanyTreeRestore(profileId, first, store);
		expect(restore.restoredContentSha256).toBe(first.manifestSha256);
		expect(restore.restoredBytes).toBe(first.totalBytes);
		expect(restore.objects).toHaveLength(objectCount);

		const target = join(await temporaryDirectory(), "materialized");
		await materializeCloudCompanyTree(target, profileId, first, store);
		await expect(readFile(join(target, "company.md"), "utf-8")).resolves.toBe("# Shared company\n");
		await expect(readFile(join(target, "app", "substrates", "market.md"), "utf-8")).resolves.toBe(
			"durable substrate\n",
		);
		await expect(readFile(join(target, "trail", "local.jsonl"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(target, ".qorpera", "staff.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			readFile(join(target, "departments", "product", "repository", "local.txt"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			readFile(join(target, "app", "tools", "example", "node_modules", "dependency", "index.js"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(target, ".git", "HEAD"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("publishes agent work product while omitting instructions and the operational inbox", async () => {
		const root = await companyFixture();
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		await mkdir(join(root, "agents", agentId, "artifacts"), { recursive: true });
		await mkdir(join(root, "agents", agentId, "skills"), { recursive: true });
		await writeFile(join(root, "agents", agentId, "instructions.md"), "# Charter\n", "utf-8");
		await writeFile(join(root, "agents", agentId, "memory.md"), "# Memory\n", "utf-8");
		await writeFile(join(root, "agents", agentId, "skills", "digest.md"), "# Skill\n", "utf-8");
		await writeFile(join(root, ".qorpera", "agent-messages.json"), "{}\n", "utf-8");
		await writeFile(join(root, "agents", agentId, "artifacts", "runway.json"), "{}\n", "utf-8");
		await mkdir(join(root, "connectors", "github"), { recursive: true });
		await writeFile(join(root, "connectors", "github", "manifest.json"), "{}\n", "utf-8");
		await mkdir(join(root, "files"), { recursive: true });
		await writeFile(join(root, "files", "notes.md"), "shared notes\n", "utf-8");
		await mkdir(join(root, "inbox", "messages"), { recursive: true });
		await writeFile(join(root, "inbox", "messages", "msg-1.json"), "{}\n", "utf-8");
		await writeFile(join(root, "inbox", "gate-1.md"), "authority gate\n", "utf-8");
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);

		const reference = await captureCloudCompanyTree(root, profileId, store);
		expect(reference.contractVersion).toBe(2);
		const target = join(await temporaryDirectory(), "materialized");
		await materializeCloudCompanyTree(target, profileId, reference, store);
		await expect(readFile(join(target, "agents", agentId, "artifacts", "runway.json"), "utf-8")).resolves.toBe(
			"{}\n",
		);
		await expect(readFile(join(target, "connectors", "github", "manifest.json"), "utf-8")).resolves.toBe("{}\n");
		await expect(readFile(join(target, "files", "notes.md"), "utf-8")).resolves.toBe("shared notes\n");
		await expect(readFile(join(target, "agents", agentId, "skills", "digest.md"), "utf-8")).resolves.toBe(
			"# Skill\n",
		);
		await expect(readFile(join(target, "agents", agentId, "instructions.md"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(target, "agents", agentId, "memory.md"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(target, ".qorpera", "agent-messages.json"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(target, "inbox", "messages", "msg-1.json"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(target, "inbox", "gate-1.md"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects aliased company files instead of silently changing their semantics", async () => {
		const root = await companyFixture();
		await link(join(root, "company.md"), join(root, "company-copy.md"));
		const store = new CloudContentAddressedStore(new MemoryObjectTransport());
		await expect(captureCloudCompanyTree(root, profileId, store)).rejects.toThrow("physical files");
	});

	it.each(["CON", "nested/COM1.txt", "notes.md:hidden", "trailing. ", "COM¹", "nested/LPT².log"])(
		"rejects Win32 namespace path %s before materialization",
		async (path) => {
			const transport = new MemoryObjectTransport();
			const store = new CloudContentAddressedStore(transport);
			const encoded = Buffer.from(
				JSON.stringify({
					schema: "qorpera.company-tree/v1",
					contractVersion: 1,
					omittedLayers: [
						"company-git-history",
						"session-trail",
						"staff-registry",
						"product-git-checkouts",
						"dependency-caches",
					],
					entries: [{ kind: "directory", path }],
				}),
				"utf-8",
			);
			const manifest = await store.putObject(profileId, encoded, "application/vnd.qorpera.company-tree+json");
			await expect(
				materializeCloudCompanyTree(
					join(await temporaryDirectory(), "materialized"),
					profileId,
					{
						manifestSha256: manifest.sha256,
						manifestBytes: manifest.bytes,
						contractVersion: 1,
						fileCount: 0,
						totalBytes: 0,
					},
					store,
				),
			).rejects.toThrow("path is invalid");
		},
	);

	it("persists one workspace identity and retries an uncertain commit with the same snapshot identity", async () => {
		const root = await companyFixture();
		const userData = await temporaryDirectory();
		const transport = new MemoryObjectTransport();
		const objects = new CloudContentAddressedStore(transport);
		let commitAttempt = 0;
		const primary: CompanyWorkspacePrimary = {
			ensureCompanyWorkspace: vi.fn(async (input) => ({
				workspaceId,
				profileId,
				environmentId,
				clientWorkspaceId: input.clientWorkspaceId,
				name: input.name,
				createdByUserId: actorUserId,
				createdAt,
				updatedAt: createdAt,
			})),
			commitCompanySnapshot: vi.fn(async (input) => {
				commitAttempt++;
				if (commitAttempt === 1) throw new Error("response lost after commit");
				return {
					snapshotId,
					profileId,
					environmentId,
					workspaceId,
					clientSnapshotId: input.clientSnapshotId,
					tree: input.tree,
					createdByUserId: actorUserId,
					createdAt,
				};
			}),
			getCompanySnapshot: vi.fn(async () => {
				throw new Error("no hosted snapshot expected");
			}),
		};
		const input = {
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			workspaceName: "Jonas MacBook",
			primary,
			objects,
		};
		await expect(checkpointCloudCompanyWorkspace(input)).rejects.toThrow("response lost");
		const stateAfterFailure = CloudCompanyWorkspaceState.open(userData, profileId, environmentId, root);
		const pendingSnapshotId = stateAfterFailure.binding.pending?.clientSnapshotId;
		expect(pendingSnapshotId).toBeDefined();
		const putsAfterFailure = transport.putCalls;

		const result = await checkpointCloudCompanyWorkspace(input);
		expect(result.changed).toBe(true);
		expect(result.snapshot.clientSnapshotId).toBe(pendingSnapshotId);
		expect(transport.putCalls).toBe(putsAfterFailure);
		const finalState = CloudCompanyWorkspaceState.open(userData, profileId, environmentId, root);
		expect(finalState.binding.clientWorkspaceId).toBe(stateAfterFailure.binding.clientWorkspaceId);
		expect(finalState.binding.pending).toBeUndefined();
	});

	it("discards a pending checkpoint rejected against the current head", async () => {
		const root = await companyFixture();
		const userData = await temporaryDirectory();
		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		const remoteHeadId = "55555555-5555-4555-8555-555555555555";
		let invocation = 0;
		const attemptedClientIds: string[] = [];
		const primary: CompanyWorkspacePrimary = {
			ensureCompanyWorkspace: vi.fn(async (input) => ({
				workspaceId,
				profileId,
				environmentId,
				clientWorkspaceId: input.clientWorkspaceId,
				name: input.name,
				...(invocation > 0 ? { headSnapshotId: remoteHeadId } : {}),
				createdByUserId: actorUserId,
				createdAt,
				updatedAt: createdAt,
			})),
			commitCompanySnapshot: vi.fn(async (input) => {
				attemptedClientIds.push(input.clientSnapshotId);
				if (invocation === 0) {
					invocation++;
					throw new Error("response lost before settlement");
				}
				throw new Error("company workspace head changed (PT409)");
			}),
			getCompanySnapshot: vi.fn(async () => {
				throw new Error("no hosted snapshot lookup expected");
			}),
		};
		const input = {
			userData,
			companyRoot: root,
			profileId,
			environmentId,
			workspaceName: "Shared company",
			primary,
			objects,
		};
		await expect(checkpointCloudCompanyWorkspace(input)).rejects.toThrow("response lost");
		await expect(checkpointCloudCompanyWorkspace(input)).rejects.toThrow("head changed on another computer");
		expect(attemptedClientIds).toHaveLength(2);
		expect(attemptedClientIds[0]).toBe(attemptedClientIds[1]);
		expect(CloudCompanyWorkspaceState.open(userData, profileId, environmentId, root).binding.pending).toBeUndefined();
	});
});
