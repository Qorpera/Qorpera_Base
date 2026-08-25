import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloudCompanyComputerHeadResolver,
	type CloudCompanyComputerSyncHead,
	hostedCompanyComputerHeadResolver,
	initializeCloudCompanyComputerCheckout,
	parseCloudCompanyComputerSyncConfig,
	runCloudCompanyComputerSyncAgent,
	syncCloudCompanyComputerCheckout,
} from "../src/cloud-company-computer-sync.ts";
import { captureCloudCompanyTree } from "../src/cloud-company-snapshot.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { HostedCompanyFile, HostedCompanySnapshot } from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const headSnapshotId = "44444444-4444-4444-8444-444444444444";
const nextSnapshotId = "55555555-5555-4555-8555-555555555555";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-26T12:00:00.000Z";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();
	getCalls = 0;

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		this.getCalls++;
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(await realpath(tmpdir()), "qorpera-company-computer-sync-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function sourceCompanyFixture(): Promise<string> {
	const root = join(await temporaryDirectory(), "source");
	scaffoldCompany(root);
	await writeFile(join(root, "company.md"), "# Shared company\n", "utf-8");
	await mkdir(join(root, "docs"), { recursive: true });
	await writeFile(join(root, "docs", "guide.md"), "guide v1\n", "utf-8");
	await mkdir(join(root, "files"), { recursive: true });
	await writeFile(join(root, "files", "notes.md"), "notes v1\n", "utf-8");
	return root;
}

interface SyncFixture {
	sourceRoot: string;
	checkoutRoot: string;
	statePath: string;
	transport: MemoryObjectTransport;
	objects: CloudContentAddressedStore;
	capture: (snapshotId: string) => Promise<CloudCompanyComputerSyncHead>;
	sync: (head: CloudCompanyComputerSyncHead) => ReturnType<typeof syncCloudCompanyComputerCheckout>;
}

function fixedHead(head: CloudCompanyComputerSyncHead): CloudCompanyComputerHeadResolver {
	return { resolveVerifiedHead: async () => head };
}

async function syncFixture(): Promise<SyncFixture> {
	const sourceRoot = await sourceCompanyFixture();
	const dataset = await temporaryDirectory();
	const checkoutRoot = join(dataset, "company");
	const statePath = join(dataset, ".qorpera-computer", "company-sync.json");
	initializeCloudCompanyComputerCheckout(checkoutRoot);
	const transport = new MemoryObjectTransport();
	const objects = new CloudContentAddressedStore(transport);
	return {
		sourceRoot,
		checkoutRoot,
		statePath,
		transport,
		objects,
		capture: async (snapshotId) => ({
			snapshotId,
			tree: await captureCloudCompanyTree(sourceRoot, profileId, objects),
		}),
		sync: (head) =>
			syncCloudCompanyComputerCheckout({
				companyRoot: checkoutRoot,
				statePath,
				profileId,
				environmentId,
				head: fixedHead(head),
				objects,
			}),
	};
}

function hostedCompanyFileFixture(overrides: Partial<HostedCompanyFile>): HostedCompanyFile {
	return {
		profileId,
		environmentId,
		canonicalWorkspaceId: workspaceId,
		state: "ready",
		logicalBytes: 0,
		retainedStorageBytes: 0,
		storageUsedBytes: 0,
		storageLimitBytes: 0,
		objectBackends: ["supabase"],
		entitlement: {
			planKey: "freemium",
			billingMode: "free",
			featureSet: "standard",
			storageAllocation: "metered",
			source: "default",
		},
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function hostedSnapshotFixture(
	head: CloudCompanyComputerSyncHead,
	overrides: Partial<HostedCompanySnapshot>,
): HostedCompanySnapshot {
	return {
		snapshotId: head.snapshotId,
		profileId,
		environmentId,
		workspaceId,
		clientSnapshotId: "66666666-6666-4666-8666-666666666666",
		tree: head.tree,
		createdByUserId: actorUserId,
		createdAt,
		publicationState: "published",
		...overrides,
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company computer sync", () => {
	it("materializes the verified head into an empty checkout and short-circuits once applied", async () => {
		const fixture = await syncFixture();
		const head = await fixture.capture(headSnapshotId);
		const first = await fixture.sync(head);
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		expect(first.skippedPaths).toEqual([]);
		expect(first.appliedPaths).toContain("company.md");
		expect(first.appliedPaths).toContain("docs/guide.md");
		await expect(readFile(join(fixture.checkoutRoot, "company.md"), "utf-8")).resolves.toBe("# Shared company\n");
		await expect(readFile(join(fixture.checkoutRoot, "docs", "guide.md"), "utf-8")).resolves.toBe("guide v1\n");
		await expect(readFile(fixture.statePath, "utf-8")).resolves.toContain(headSnapshotId);

		const getsAfterApply = fixture.transport.getCalls;
		const second = await fixture.sync(head);
		expect(second).toEqual({ status: "up-to-date", snapshotId: headSnapshotId });
		expect(fixture.transport.getCalls).toBe(getsAfterApply);
	});

	it("fast-forwards only the paths the new head changed", async () => {
		const fixture = await syncFixture();
		await fixture.sync(await fixture.capture(headSnapshotId));
		await writeFile(join(fixture.sourceRoot, "docs", "guide.md"), "guide v2\n", "utf-8");
		await writeFile(join(fixture.sourceRoot, "docs", "extra.md"), "extra\n", "utf-8");
		await rm(join(fixture.sourceRoot, "files", "notes.md"));
		const next = await fixture.sync(await fixture.capture(nextSnapshotId));
		expect(next.status).toBe("applied");
		if (next.status !== "applied") return;
		expect(next.appliedPaths).toEqual(["docs/extra.md", "docs/guide.md", "files/notes.md"]);
		expect(next.skippedPaths).toEqual([]);
		await expect(readFile(join(fixture.checkoutRoot, "docs", "guide.md"), "utf-8")).resolves.toBe("guide v2\n");
		await expect(readFile(join(fixture.checkoutRoot, "docs", "extra.md"), "utf-8")).resolves.toBe("extra\n");
		await expect(readFile(join(fixture.checkoutRoot, "files", "notes.md"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("skips locally diverged files and fast-forwards them once the divergence is gone", async () => {
		const fixture = await syncFixture();
		await fixture.sync(await fixture.capture(headSnapshotId));
		await writeFile(join(fixture.checkoutRoot, "docs", "guide.md"), "local work in progress\n", "utf-8");
		await writeFile(join(fixture.sourceRoot, "docs", "guide.md"), "guide v2\n", "utf-8");
		await writeFile(join(fixture.sourceRoot, "company.md"), "# Renamed company\n", "utf-8");
		const nextHead = await fixture.capture(nextSnapshotId);

		const diverged = await fixture.sync(nextHead);
		expect(diverged.status).toBe("applied");
		if (diverged.status !== "applied") return;
		expect(diverged.skippedPaths).toEqual(["docs/guide.md"]);
		expect(diverged.appliedPaths).toEqual(["company.md"]);
		await expect(readFile(join(fixture.checkoutRoot, "docs", "guide.md"), "utf-8")).resolves.toBe(
			"local work in progress\n",
		);
		await expect(readFile(join(fixture.checkoutRoot, "company.md"), "utf-8")).resolves.toBe("# Renamed company\n");

		await writeFile(join(fixture.checkoutRoot, "docs", "guide.md"), "guide v1\n", "utf-8");
		const recovered = await fixture.sync(nextHead);
		expect(recovered.status).toBe("applied");
		if (recovered.status !== "applied") return;
		expect(recovered.appliedPaths).toEqual(["docs/guide.md"]);
		expect(recovered.skippedPaths).toEqual([]);
		await expect(readFile(join(fixture.checkoutRoot, "docs", "guide.md"), "utf-8")).resolves.toBe("guide v2\n");
		await expect(fixture.sync(nextHead)).resolves.toEqual({ status: "up-to-date", snapshotId: nextSnapshotId });
	});

	it("never deletes a directory that still holds local work", async () => {
		const fixture = await syncFixture();
		await fixture.sync(await fixture.capture(headSnapshotId));
		await writeFile(join(fixture.checkoutRoot, "docs", "notes-local.md"), "keep me\n", "utf-8");
		await rm(join(fixture.sourceRoot, "docs"), { recursive: true });
		const next = await fixture.sync(await fixture.capture(nextSnapshotId));
		expect(next.status).toBe("applied");
		if (next.status !== "applied") return;
		expect(next.appliedPaths).toEqual(["docs/guide.md"]);
		expect(next.skippedPaths).toEqual(["docs"]);
		await expect(readFile(join(fixture.checkoutRoot, "docs", "notes-local.md"), "utf-8")).resolves.toBe("keep me\n");
		await expect(readFile(join(fixture.checkoutRoot, "docs", "guide.md"), "utf-8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("adopts a checkout that already matches the head after the sync state is lost", async () => {
		const fixture = await syncFixture();
		const head = await fixture.capture(headSnapshotId);
		await fixture.sync(head);
		await rm(fixture.statePath);
		const adopted = await fixture.sync(head);
		expect(adopted.status).toBe("applied");
		if (adopted.status !== "applied") return;
		expect(adopted.skippedPaths).toEqual([]);
		expect(adopted.appliedPaths).toContain("company.md");
		await expect(fixture.sync(head)).resolves.toEqual({ status: "up-to-date", snapshotId: headSnapshotId });
		await expect(readFile(join(fixture.checkoutRoot, "company.md"), "utf-8")).resolves.toBe("# Shared company\n");
	});

	it("applies executable-bit changes without touching file content", async () => {
		const fixture = await syncFixture();
		await writeFile(join(fixture.sourceRoot, "files", "run.sh"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o644 });
		await fixture.sync(await fixture.capture(headSnapshotId));
		await chmod(join(fixture.sourceRoot, "files", "run.sh"), 0o755);
		const next = await fixture.sync(await fixture.capture(nextSnapshotId));
		expect(next.status).toBe("applied");
		if (next.status !== "applied") return;
		expect(next.appliedPaths).toEqual(["files/run.sh"]);
		if (process.platform !== "win32") {
			const mode = (await stat(join(fixture.checkoutRoot, "files", "run.sh"))).mode;
			expect(mode & 0o111).not.toBe(0);
		}
	});

	it("removes stale sync staging while leaving merge transactions for their own recovery", async () => {
		const fixture = await syncFixture();
		const transactionParent = join(fixture.checkoutRoot, ".qorpera", "w");
		await mkdir(join(transactionParent, "cloud-sync-stale"), { recursive: true });
		await mkdir(join(transactionParent, "cloud-merge-crashed"), { recursive: true });
		await fixture.sync(await fixture.capture(headSnapshotId));
		const remaining = await readdir(transactionParent);
		expect(remaining).toContain("cloud-merge-crashed");
		expect(remaining.filter((name) => name.startsWith("cloud-sync-"))).toEqual([]);
	});

	it("resolves only a published head from the hosted Company File record", async () => {
		const fixture = await syncFixture();
		const head = await fixture.capture(headSnapshotId);
		const snapshots = new Map<string, HostedCompanySnapshot>();
		let companyFile = hostedCompanyFileFixture({ state: "provisioning" });
		const resolver = hostedCompanyComputerHeadResolver(
			{
				getCompanyFile: async (requestedEnvironmentId) => {
					expect(requestedEnvironmentId).toBe(environmentId);
					return companyFile;
				},
				getCompanySnapshot: async (snapshotId) => {
					const snapshot = snapshots.get(snapshotId);
					if (!snapshot) throw new Error("no snapshot");
					return snapshot;
				},
			},
			profileId,
			environmentId,
		);
		await expect(resolver.resolveVerifiedHead()).resolves.toBeUndefined();

		companyFile = hostedCompanyFileFixture({ headSnapshotId: head.snapshotId });
		snapshots.set(head.snapshotId, hostedSnapshotFixture(head, { publicationState: "prepared" }));
		await expect(resolver.resolveVerifiedHead()).rejects.toThrow("not a published snapshot");

		snapshots.set(head.snapshotId, hostedSnapshotFixture(head, {}));
		await expect(resolver.resolveVerifiedHead()).resolves.toEqual(head);

		snapshots.set(head.snapshotId, hostedSnapshotFixture(head, { environmentId: workspaceId }));
		await expect(resolver.resolveVerifiedHead()).rejects.toThrow("outside this profile environment");
	});

	it("parses exactly the bootstrap sync block and rejects out-of-contract values", () => {
		expect(
			parseCloudCompanyComputerSyncConfig({
				company_root: "/srv/qorpera/dataset/company",
				state_path: "/srv/qorpera/dataset/.qorpera-computer/company-sync.json",
				poll_seconds: 30,
				future_field: true,
			}),
		).toEqual({
			companyRoot: "/srv/qorpera/dataset/company",
			statePath: "/srv/qorpera/dataset/.qorpera-computer/company-sync.json",
			pollSeconds: 30,
		});
		expect(() =>
			parseCloudCompanyComputerSyncConfig({
				company_root: "relative/company",
				state_path: "/s.json",
				poll_seconds: 30,
			}),
		).toThrow("company root is invalid");
		expect(() =>
			parseCloudCompanyComputerSyncConfig({ company_root: "/c", state_path: "/s.json", poll_seconds: 4 }),
		).toThrow("poll interval is invalid");
		expect(() =>
			parseCloudCompanyComputerSyncConfig({ company_root: "/c", state_path: "/s.json", poll_seconds: 3_601 }),
		).toThrow("poll interval is invalid");
		expect(() => parseCloudCompanyComputerSyncConfig(undefined)).toThrow("configuration is invalid");
	});

	it("rejects a runtime lock that belongs to another company", async () => {
		const fixture = await syncFixture();
		const head = await fixture.capture(headSnapshotId);
		const otherRoot = await temporaryDirectory();
		await expect(
			syncCloudCompanyComputerCheckout({
				companyRoot: fixture.checkoutRoot,
				statePath: fixture.statePath,
				profileId,
				environmentId,
				head: fixedHead(head),
				objects: fixture.objects,
				runtimeLock: {
					path: join(otherRoot, "lock.json"),
					root: otherRoot,
					token: "token",
					processInstance: "instance",
					release: () => {},
				},
			}),
		).rejects.toThrow("lock belongs to another company");
	});

	it("fails closed instead of fabricating a checkout on an unmounted dataset", async () => {
		const missingDataset = join(await temporaryDirectory(), "missing", "company");
		expect(() => initializeCloudCompanyComputerCheckout(missingDataset)).toThrow("dataset is not mounted");
	});

	it("runs the poll loop from the bootstrap config until aborted", async () => {
		const sourceRoot = await sourceCompanyFixture();
		const dataset = await temporaryDirectory();
		const transport = new MemoryObjectTransport();
		const objects = new CloudContentAddressedStore(transport);
		const head: CloudCompanyComputerSyncHead = {
			snapshotId: headSnapshotId,
			tree: await captureCloudCompanyTree(sourceRoot, profileId, objects),
		};
		const config = parseCloudCompanyComputerSyncConfig({
			company_root: join(dataset, "company"),
			state_path: join(dataset, ".qorpera-computer", "company-sync.json"),
			poll_seconds: 30,
		});
		const controller = new AbortController();
		const results: string[] = [];
		await runCloudCompanyComputerSyncAgent({
			config,
			profileId,
			environmentId,
			head: fixedHead(head),
			objects,
			signal: controller.signal,
			onResult: (result) => {
				results.push(result.status);
				controller.abort();
			},
			onError: (error) => {
				throw error;
			},
		});
		expect(results).toEqual(["applied"]);
		await expect(readFile(join(dataset, "company", "company.md"), "utf-8")).resolves.toBe("# Shared company\n");
	});
});
