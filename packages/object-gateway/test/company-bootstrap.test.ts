import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompanyBootstrapProvisioner } from "../src/company-bootstrap.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import type { MemberCompanyAuthority } from "../src/member-company-authority.ts";

const workerId = "32000000-0000-4000-8000-000000000001";
const jobId = "32000000-0000-4000-8000-000000000002";
const profileId = "32000000-0000-4000-8000-000000000003";
const environmentId = "32000000-0000-4000-8000-000000000004";
const firstRunInputId = "32000000-0000-4000-8000-000000000005";
const snapshotId = "32000000-0000-4000-8000-000000000006";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

function fixture(overrides: Record<string, unknown> = {}, legacyObjects = new Map<string, Buffer>()) {
	const formationDocument = JSON.stringify({
		schema: "qorpera.company-formation/v1",
		formationId: "32000000-0000-4000-8000-000000000007",
		cofounderStaffAgentId: "32000000-0000-4000-8000-000000000008",
		state: "source_inventory",
		status: "active",
		revision: 1,
	});
	const cofounderAgentDocument = JSON.stringify({
		schema: "qorpera.company-agent/v1",
		agentId: "32000000-0000-4000-8000-000000000008",
		revision: 1,
		displayName: "Co-Founder",
		role: "Company formation and founder partnership",
		hireOverlay: { charter: "Help form and operate the company.", templateId: "co-founder" },
		appearance: { color: "#0071e3", shape: "round", creature: "pebble" },
		modelPolicy: { provider: null, modelId: null },
		reasoningPolicy: { effort: "low" },
		grants: { department: null, projects: [], rooms: [], resources: [] },
		startupInstructions: "Begin the durable company-formation workflow.",
		employmentStatus: "active",
		lifecycleState: "setup",
		createdAt: "2026-08-29T00:00:00Z",
	});
	const claim = {
		schema: "qorpera.company-bootstrap-claim/v1",
		jobId,
		profileId,
		environmentId,
		leaseOwner: workerId,
		leaseExpiresAt: "2099-01-01T00:00:00Z",
		createdByUserId: "32000000-0000-4000-8000-000000000009",
		cofounderStaffAgentId: "32000000-0000-4000-8000-000000000008",
		formationId: "32000000-0000-4000-8000-000000000007",
		memberSessionId: "32000000-0000-4000-8000-000000000010",
		formationDocument,
		cofounderAgentDocument,
		pathGatewayVersion: null,
		baseSnapshotId: null,
		baseTreeSha256: null,
		baseTreeBytes: null,
		...overrides,
	};
	const staged = new Map<string, Buffer>();
	let claimed = false;
	const publisher: MemberCompanyAuthority["publisher"] = vi.fn(async (method, args) => {
		if (method === "qorpera_claim_company_bootstrap") {
			if (claimed) return null;
			claimed = true;
			return claim;
		}
		if (method === "qorpera_stage_company_bootstrap_object") return profileId;
		if (method === "qorpera_verify_company_path_file") {
			const manifest = object(JSON.parse(String(args.p_manifest_text)));
			const content = [formationDocument, cofounderAgentDocument]
				.map((document) => Buffer.from(document))
				.find((candidate) => createHash("sha256").update(candidate).digest("hex") === manifest.fileSha256);
			if (content) {
				expect(manifest).toEqual({
					schema: "qorpera.cloud-file-manifest/v1",
					fileSha256: createHash("sha256").update(content).digest("hex"),
					bytes: content.length,
					mediaType: "application/octet-stream",
					chunks: [{ sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length }],
				});
			}
			return null;
		}
		if (method === "qorpera_verify_company_path_tree") {
			const text = String(args.p_manifest_text);
			const tree = object(JSON.parse(text));
			expect(tree.schema).toBe("qorpera.company-tree/v1");
			expect(tree.contractVersion).toBe(3);
			const paths = (tree.entries as Array<Record<string, unknown>>).map((entry) => entry.path);
			if (createHash("sha256").update(text).digest("hex") !== claim.baseTreeSha256) {
				expect(paths).toEqual(
					claim.pathGatewayVersion === 1
						? ["notes.txt", "organization"]
						: claim.baseTreeSha256
							? [
									"notes.txt",
									"organization",
									"organization/agents",
									"organization/agents/32000000-0000-4000-8000-000000000008.json",
									"organization/departments",
									"organization/formation.json",
									"organization/projects",
								]
							: [
									"organization",
									"organization/agents",
									"organization/agents/32000000-0000-4000-8000-000000000008.json",
									"organization/departments",
									"organization/formation.json",
									"organization/projects",
								],
				);
			}
			return createHash("sha256").update(text).digest("hex");
		}
		if (method === "qorpera_finalize_company_bootstrap") {
			expect(args).toMatchObject({ p_job_id: jobId, p_worker_id: workerId });
			return {
				schema: "qorpera.company-bootstrap-result/v1",
				state: claim.pathGatewayVersion === 1 ? "provisioning" : "completed",
				profileId,
				environmentId,
				snapshotId,
				firstRunInputId: claim.pathGatewayVersion === 1 ? null : firstRunInputId,
			};
		}
		throw new Error(`Unexpected publisher RPC ${method}`);
	});
	const authority: MemberCompanyAuthority = {
		member: async () => {
			throw new Error("Member authority must not create a company");
		},
		publisher,
	};
	const replication = {
		async uploadWithAuthority(
			storedProfileId: string,
			sha256: string,
			bytes: Uint8Array,
			authorityCallbacks: { authorize(): Promise<void>; confirm(): Promise<void> },
		) {
			expect(storedProfileId).toBe(profileId);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
			await authorityCallbacks.authorize();
			staged.set(sha256, Buffer.from(bytes));
			await authorityCallbacks.confirm();
			return "stored";
		},
	};
	return {
		formationDocument,
		cofounderAgentDocument,
		staged,
		publisher,
		provisioner: new CompanyBootstrapProvisioner({
			workerId,
			authority,
			store: {
				async get(storedProfileId, sha256) {
					if (storedProfileId !== profileId) throw new Error("Object not found");
					const value = staged.get(sha256) ?? legacyObjects.get(sha256);
					if (!value) throw new Error("Object not found");
					return value;
				},
			},
			replication,
			readLegacyObject: async (_storedProfileId, sha256) => {
				const value = legacyObjects.get(sha256);
				if (!value) throw new Error("Legacy object is unavailable");
				return value;
			},
		}),
	};
}

describe("cloud-owned company bootstrap", () => {
	it("publishes the exact deterministic organization tree before finalizing one first run", async () => {
		const service = fixture();
		expect(await service.provisioner.provisionOne()).toBe(true);
		expect(await service.provisioner.provisionOne()).toBe(false);
		expect(service.staged.size).toBe(5);
		expect([...service.staged.values()].some((value) => value.toString() === service.formationDocument)).toBe(true);
		expect([...service.staged.values()].some((value) => value.toString() === service.cofounderAgentDocument)).toBe(
			true,
		);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_finalize_company_bootstrap",
			expect.objectContaining({ p_job_id: jobId, p_worker_id: workerId }),
			expect.any(AbortSignal),
		);
	});

	it.each([
		{ leaseOwner: "32000000-0000-4000-8000-000000000011" },
		{ unexpected: true },
		{ formationDocument: "x".repeat(32 * 1024 + 1) },
	])("rejects malformed cloud claims before staging: %j", async (override) => {
		const service = fixture(override);
		await expect(service.provisioner.provisionOne()).rejects.toBeInstanceOf(ObjectDependencyError);
		expect(service.staged.size).toBe(0);
	});

	it("preserves an existing Company File while adding the canonical organization layout", async () => {
		const initial = fixture();
		const formation = Buffer.from(initial.formationDocument);
		const evolvedAgentDocument = JSON.stringify({
			...JSON.parse(initial.cofounderAgentDocument),
			revision: 2,
			displayName: "Operating Co-Founder",
			lifecycleState: "active",
		});
		const evolvedAgent = Buffer.from(evolvedAgentDocument);
		const note = Buffer.from("Keep this company state");
		const objects = new Map<string, Buffer>();
		const manifest = (content: Buffer): { bytes: Buffer; sha256: string; fileSha256: string } => {
			const fileSha256 = createHash("sha256").update(content).digest("hex");
			const bytes = Buffer.from(
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v1",
					fileSha256,
					bytes: content.length,
					mediaType: "application/octet-stream",
					chunks: [{ sha256: fileSha256, bytes: content.length }],
				}),
			);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			objects.set(fileSha256, content);
			objects.set(sha256, bytes);
			return { bytes, sha256, fileSha256 };
		};
		const formationManifest = manifest(formation);
		const agentManifest = manifest(evolvedAgent);
		const noteManifest = manifest(note);
		const tree = Buffer.from(
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
				entries: [
					{
						path: "notes.txt",
						kind: "file",
						executable: false,
						file: {
							manifestSha256: noteManifest.sha256,
							fileSha256: noteManifest.fileSha256,
							bytes: note.length,
							mediaType: "application/octet-stream",
						},
					},
					{
						path: "organization/agents/32000000-0000-4000-8000-000000000008.json",
						kind: "file",
						executable: false,
						file: {
							manifestSha256: agentManifest.sha256,
							fileSha256: agentManifest.fileSha256,
							bytes: evolvedAgent.length,
							mediaType: "application/octet-stream",
						},
					},
					{
						path: "organization/formation.json",
						kind: "file",
						executable: false,
						file: {
							manifestSha256: formationManifest.sha256,
							fileSha256: formationManifest.fileSha256,
							bytes: formation.length,
							mediaType: "application/octet-stream",
						},
					},
				],
			}),
		);
		const treeSha256 = createHash("sha256").update(tree).digest("hex");
		objects.set(treeSha256, tree);
		const service = fixture(
			{
				baseSnapshotId: "32000000-0000-4000-8000-000000000012",
				baseTreeSha256: treeSha256,
				baseTreeBytes: tree.length,
			},
			objects,
		);
		expect(await service.provisioner.provisionOne()).toBe(true);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_finalize_company_bootstrap",
			expect.objectContaining({
				p_formation_document: initial.formationDocument,
				p_organization_documents: {
					"organization/agents/32000000-0000-4000-8000-000000000008.json": evolvedAgentDocument,
					"organization/formation.json": initial.formationDocument,
				},
			}),
			expect.any(AbortSignal),
		);
	});

	it("advances an existing governed Company File by one durable path per bootstrap attempt", async () => {
		const note = Buffer.from("Keep this company state");
		const noteSha256 = createHash("sha256").update(note).digest("hex");
		const noteManifest = Buffer.from(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: noteSha256,
				bytes: note.length,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: noteSha256, bytes: note.length }],
			}),
		);
		const noteManifestSha256 = createHash("sha256").update(noteManifest).digest("hex");
		const tree = Buffer.from(
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
				entries: [
					{
						path: "notes.txt",
						kind: "file",
						executable: false,
						file: {
							manifestSha256: noteManifestSha256,
							fileSha256: noteSha256,
							bytes: note.length,
							mediaType: "application/octet-stream",
						},
					},
				],
			}),
		);
		const treeSha256 = createHash("sha256").update(tree).digest("hex");
		const objects = new Map<string, Buffer>([
			[noteSha256, note],
			[noteManifestSha256, noteManifest],
			[treeSha256, tree],
		]);
		const service = fixture(
			{
				pathGatewayVersion: 1,
				baseSnapshotId: "32000000-0000-4000-8000-000000000012",
				baseTreeSha256: treeSha256,
				baseTreeBytes: tree.length,
			},
			objects,
		);

		expect(await service.provisioner.provisionOne()).toBe(true);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_finalize_company_bootstrap",
			expect.objectContaining({ p_organization_documents: {} }),
			expect.any(AbortSignal),
		);
	});
});
