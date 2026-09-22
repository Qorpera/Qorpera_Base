import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompanyBootstrapOptions, CompanyBootstrapProvisioner } from "../src/company-bootstrap.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";

const workerId = "32000000-0000-4000-8000-000000000001";
const jobId = "32000000-0000-4000-8000-000000000002";
const profileId = "32000000-0000-4000-8000-000000000003";
const environmentId = "32000000-0000-4000-8000-000000000004";
const snapshotId = "32000000-0000-4000-8000-000000000006";
const formationId = "32000000-0000-4000-8000-000000000007";
const cofounderId = "32000000-0000-4000-8000-000000000008";
const roots: string[] = [];

function hash(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(backend: "nas" | "legacy" = "nas") {
	const root = await mkdtemp(join(tmpdir(), "qorpera-bootstrap-store-"));
	roots.push(root);
	const store = new FileSystemObjectStore(root);
	const objects = new Map<string, Buffer>();
	const catalog = new Map<string, number>();
	const formationDocument = JSON.stringify({
		schema: "qorpera.company-formation/v1",
		formationId,
		cofounderStaffAgentId: cofounderId,
		state: "source_inventory",
		status: "active",
		revision: 1,
	});
	const agentDocument = JSON.stringify({ schema: "qorpera.company-agent/v1", agentId: cofounderId, revision: 1 });
	let head = Buffer.from(
		JSON.stringify({
			schema: "qorpera.company-tree/v1",
			contractVersion: 3,
			omittedLayers: [
				"company-git-history",
				"session-trail",
				"staff-registry",
				"product-git-checkouts",
				"dependency-caches",
				"staff-instructions",
				"system-metadata",
			],
			entries: [],
		}),
	);
	objects.set(hash(head), head);
	catalog.set(hash(head), head.length);
	await store.put(profileId, hash(head), head);
	const state = { finalized: 0, completed: false };
	const authorizeServiceDownload = vi.fn(async (company: string, sha256: string): Promise<{ bytes: number }> => {
		if (company !== profileId) throw new ObjectDependencyError(403);
		const bytes = catalog.get(sha256);
		if (bytes === undefined) throw new ObjectDependencyError(404);
		return { bytes };
	});
	const readLegacyObject = vi.fn(async (company: string, sha256: string) => {
		if (company !== profileId) throw new ObjectDependencyError(403);
		const bytes = objects.get(sha256);
		if (!bytes) throw new ObjectDependencyError(404);
		return bytes;
	});
	const options: CompanyBootstrapOptions = {
		workerId,
		store,
		authorizeServiceDownload,
		readLegacyObject,
		authority: {
			member: async () => {
				throw new Error("Bootstrap must not use member credentials");
			},
			publisher: async (method, args) => {
				if (method === "qorpera_claim_company_bootstrap") {
					if (state.completed) return null;
					return {
						schema: "qorpera.company-bootstrap-claim/v1",
						jobId,
						profileId,
						environmentId,
						leaseOwner: workerId,
						leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
						createdByUserId: "32000000-0000-4000-8000-000000000009",
						cofounderStaffAgentId: cofounderId,
						formationId,
						memberSessionId: "32000000-0000-4000-8000-000000000010",
						formationDocument,
						cofounderAgentDocument: agentDocument,
						cofounderResponsibilityDocuments: {},
						pathGatewayVersion: 1,
						baseSnapshotId: snapshotId,
						baseTreeSha256: hash(head),
						baseTreeBytes: head.length,
					};
				}
				if (method === "qorpera_stage_company_bootstrap_object") {
					if (args.p_confirm === true) catalog.set(String(args.p_sha256), Number(args.p_bytes));
					return profileId;
				}
				if (method === "qorpera_verify_company_path_file") return null;
				if (method === "qorpera_verify_company_path_tree") return hash(String(args.p_manifest_text));
				if (method === "qorpera_finalize_company_bootstrap") {
					head = Buffer.from(String(args.p_tree_manifest_text));
					state.finalized++;
					// organization, agents, projects, formation.json and the Co-Founder document: five steps.
					state.completed = state.finalized === 5;
					if (state.completed) {
						expect(args.p_organization_documents).toEqual({
							"organization/formation.json": formationDocument,
							[`organization/agents/${cofounderId}.json`]: agentDocument,
						});
					}
					return {
						schema: "qorpera.company-bootstrap-result/v1",
						state: state.completed ? "completed" : "provisioning",
						profileId,
						environmentId,
						snapshotId,
						firstRunInputId: null,
					};
				}
				throw new Error("Unexpected bootstrap publisher call");
			},
		},
		replication: {
			uploadWithAuthority: async (company, sha256, bytes, authority) => {
				expect(company).toBe(profileId);
				await authority.authorize();
				await store.put(company, sha256, bytes);
				objects.set(sha256, Buffer.from(bytes));
				await authority.confirm();
			},
		},
	};
	return {
		root,
		objects,
		catalog,
		state,
		authorizeServiceDownload,
		readLegacyObject,
		async advance() {
			if (backend === "legacy") {
				for (const sha256 of objects.keys()) await store.remove(profileId, sha256);
			}
			// Each attempt opens the same disk with a new store, like a restarted gateway.
			return new CompanyBootstrapProvisioner({ ...options, store: new FileSystemObjectStore(root) }).provisionOne();
		},
	};
}

describe("company bootstrap with the production filesystem store", () => {
	it.each(["nas", "legacy"] as const)(
		"finishes a governed bootstrap across restarts using %s reads",
		async (backend) => {
			const service = await fixture(backend);
			for (let attempt = 1; attempt <= 5; attempt++) {
				expect(await service.advance()).toBe(true);
				expect(service.state.finalized).toBe(attempt);
			}
			expect(await service.advance()).toBe(false);
			expect(service.state.completed).toBe(true);
			expect(service.authorizeServiceDownload).toHaveBeenCalledOnce();
			expect(service.authorizeServiceDownload).toHaveBeenCalledWith(
				profileId,
				expect.stringMatching(/^[a-f0-9]{64}$/),
			);
			if (backend === "nas") expect(service.readLegacyObject).not.toHaveBeenCalled();
			else expect(service.readLegacyObject).toHaveBeenCalled();
		},
	);

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8 * 1024 * 1024 + 1])(
		"rejects an invalid authoritative manifest byte count: %s",
		async (bytes) => {
			const service = await fixture();
			for (let attempt = 0; attempt < 4; attempt++) await service.advance();
			service.authorizeServiceDownload.mockResolvedValueOnce({ bytes });
			await expect(service.advance()).rejects.toMatchObject({ status: 503 });
			expect(service.state.finalized).toBe(4);
			expect(service.readLegacyObject).not.toHaveBeenCalled();
		},
	);

	it("does not read or fall back after a manifest authorization denial", async () => {
		const service = await fixture();
		for (let attempt = 0; attempt < 4; attempt++) await service.advance();
		service.authorizeServiceDownload.mockRejectedValueOnce(new ObjectDependencyError(403));
		await expect(service.advance()).rejects.toMatchObject({ status: 403 });
		expect(service.state.finalized).toBe(4);
		expect(service.readLegacyObject).not.toHaveBeenCalled();
	});

	it.each(["nas", "legacy"] as const)(
		"rejects a valid manifest whose %s byte count disagrees with authority",
		async (backend) => {
			const service = await fixture(backend);
			for (let attempt = 0; attempt < 4; attempt++) await service.advance();
			service.authorizeServiceDownload.mockImplementationOnce(async (_company, sha256) => ({
				bytes: (service.catalog.get(sha256) ?? 0) + 1,
			}));
			await expect(service.advance()).rejects.toThrow();
			expect(service.state.finalized).toBe(4);
		},
	);

	it("rejects a corrupted NAS manifest without substituting a valid legacy copy", async () => {
		const service = await fixture();
		for (let attempt = 0; attempt < 4; attempt++) await service.advance();
		service.authorizeServiceDownload.mockImplementationOnce(async (_company, sha256) => {
			const bytes = service.objects.get(sha256);
			if (!bytes) throw new Error("Missing test manifest");
			await writeFile(join(service.root, profileId, sha256), Buffer.alloc(bytes.length));
			return { bytes: bytes.length };
		});
		await expect(service.advance()).rejects.toThrow("Stored object failed integrity verification");
		expect(service.state.finalized).toBe(4);
		expect(service.readLegacyObject).not.toHaveBeenCalled();
	});
});
