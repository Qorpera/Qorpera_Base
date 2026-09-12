import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CompanyComputerCodePackageProvisionReceipt,
	CompanyComputerCodePackageProvisionRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import type { LxdOfficeCodePackageClient } from "../../src/lxd-client.ts";
import type { LxdOfficeCodePackageRegistry } from "../../src/lxd-office-code-package-control.ts";
import { loadLxdOfficeCodePackageMaterial } from "../../src/lxd-office-code-package-material.ts";
import { LxdOfficeCodePackageProvisionLane } from "../../src/lxd-office-code-package-provision-lane.ts";
import { lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import { officeCodePackageMaterialFixture } from "./office-code-package-material.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal,
	encode = (v: unknown) => Buffer.from(officeCanonical(v));
export async function cleanupOfficeCodePackagePipelineFixtures() {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}
export async function officeCodePackagePipelineFixture() {
	const f = officeCodePackageMaterialFixture(),
		root = await realpath(await mkdtemp(join(tmpdir(), "package-lane-")));
	roots.push(root);
	const material = await loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports),
		files = new Map<string, Buffer>(),
		actions: string[] = [],
		methods: string[] = [];
	let request: CompanyComputerCodePackageProvisionRequest | null = null,
		receipt: CompanyComputerCodePackageProvisionReceipt | null = null,
		claim: unknown = null,
		state = "enrolled",
		installationEvidenceSha256: string | null = null,
		loseInstall = false,
		tamperObservation = false,
		loseDispatch = false;
	const status = () => ({
		schema: "qorpera.office-code-package-provision-status/v1",
		plan: material.verified.plan,
		planSha256: material.verified.planSha256,
		statement: material.verified.statement,
		state,
		targetRevision: 1,
		currentPackageRevision: state === "installed" ? 1 : 0,
		capabilityRevision: 1,
		request,
		requestSha256: request ? officeDigest(request) : null,
		receipt: state === "installed" ? receipt : null,
		receiptSha256: state === "installed" ? officeDigest(receipt) : null,
		installationEvidenceSha256,
	});
	const registry: LxdOfficeCodePackageRegistry = {
		call: vi.fn(async (method, args) => {
			methods.push(method);
			expect(args.p_provider_capability).toBe(f.capability);
			if (method === "qorpera_check_office_package_provision") {
				request = JSON.parse(args.p_request_text as string);
				state = "authorized";
				if (loseDispatch) throw new Error("lost SQL reply");
				return {
					schema: "qorpera.office-code-package-dispatch-challenge/v1",
					request,
					requestSha256: officeDigest(request),
					statement: material.verified.statement,
					targetRevision: 1,
					capabilityRevision: 1,
					validForMs: 5000,
				};
			}
			if (method === "qorpera_check_office_package_provision_observation")
				return {
					schema: "qorpera.office-code-package-observation-challenge/v1",
					provisionId: f.plan.provisionId,
					observationId: args.p_observation_id,
					request,
					requestSha256: officeDigest(request),
					statement: material.verified.statement,
					targetRevision: 1,
					capabilityRevision: 1,
					validForMs: 5000,
				};
			if (method === "qorpera_ack_office_package_provision") {
				state = "installed";
				installationEvidenceSha256 = args.p_evidence_sha256 as string;
				return status();
			}
			if (method === "qorpera_check_office_package_invocation")
				return {
					schema: "qorpera.office-code-package-invocation-challenge/v1",
					challengeId: args.p_challenge_id,
					activationId: args.p_activation_id,
					startup: args.p_startup,
					provisionId: f.plan.provisionId,
					planSha256: material.verified.planSha256,
					revision: 1,
					receiptSha256: officeDigest(receipt),
					installedInventorySha256: material.verified.inventorySha256,
					service: material.verified.statement.target.service,
					runtimeBundle: material.verified.statement.target.runtimeBundle,
					capabilityRevision: 1,
					validForMs: 5000,
				};
			if (method === "qorpera_ack_office_package_invocation")
				return {
					schema: "qorpera.office-code-package-invocation-measurement/v1",
					activationId: args.p_activation_id,
					provisionId: f.plan.provisionId,
					revision: 1,
					state: "measured",
				};
			return status();
		}),
	};
	const client: LxdOfficeCodePackageClient = {
		discoverOfficeCodePackage: async () => (receipt ? f.plan.provisionId : undefined),
		pushOfficeCodePackageDirectory: async () => {},
		pushOfficeCodePackageFile: async (_p, _n, _id, file, content) => {
			actions.push(`stage:${file}`);
			files.set(file, Buffer.from(content));
		},
		readOfficeCodePackageFile: async (_p, _n, _id, file) => {
			const b = files.get(file);
			if (!b) throw new Error("missing output");
			return { content: Buffer.from(b), uid: 0, gid: 0, mode: 0o400 };
		},
		readOfficeCodePackageReceipt: async (_p, _n, _id, file) => {
			if (!receipt) throw new Error("missing installed");
			return { content: encode(file === "claim" ? claim : receipt), uid: 0, gid: 0, mode: 0o400 };
		},
		inspectOfficeCodePackageTool: async () => "succeeded",
		submitOfficeCodePackageTool: async (_p, _n, _id, purpose, _pin, args) => {
			const packet = JSON.parse(files.get("packet.json")!.toString()),
				mode = args[0];
			actions.push(`${purpose}:${mode}`);
			if (mode === "preflight" || mode === "probe") {
				const challengeId = mode === "preflight" ? packet.request.challengeId : args[3],
					probeId = args[3],
					probe = {
						schema: "qorpera.office-code-package-probe/v1",
						purpose: mode === "preflight" ? "install" : "measure",
						provisionId: f.plan.provisionId,
						probeId,
						packetSha256: args[1],
						bootId: mode === "preflight" ? packet.request.bootId : args[4],
						challengeId,
						nonce: randomUUID(),
						monotonicNs: "10000",
					};
				files.set(`${mode === "preflight" ? "preflight" : "probe"}-${probeId}.json`, encode(probe));
			}
			if (mode === "install") {
				claim = {
					schema: "qorpera.office-code-package-install-claim/v1",
					requestSha256: officeDigest(packet.request),
					packetSha256: officeDigest(packet),
					probe: JSON.parse(files.get(`preflight-${args[3]}.json`)!.toString()),
				};
				const r = packet.request;
				receipt = {
					schema: "qorpera.office-code-package-provision-receipt/v1",
					planSha256: r.planSha256,
					provisionId: f.plan.provisionId,
					resetId: f.resetPlan.resetId,
					rootIncarnationId: f.resetPlan.rootIncarnationId,
					bootId: r.bootId,
					commandId: f.plan.installCommandId,
					requestSha256: officeDigest(r),
					restoreSha256: r.restoreSha256,
					state: "installed",
					targetRevision: 1,
					packageManifestSha256: material.verified.statement.target.packageManifestSha256,
					installedInventorySha256: material.verified.inventorySha256,
					sourceCommit: material.verified.statement.target.sourceCommit,
					runtimeBundle: material.verified.statement.target.runtimeBundle,
					service: material.verified.statement.target.service,
				};
				if (loseInstall) throw new Error("lost install reply");
			}
			if (mode === "observation" || mode === "invocation") {
				if (!receipt) throw new Error("missing installed");
				const challenge = JSON.parse(files.get(`challenge-${args[3]}.json`)!.toString());
				expect(Number(args[5])).toBe(challenge.validForMs);
				expect(args[6]).toBe(officeDigest(challenge));
				const output =
					mode === "observation"
						? {
								schema: "qorpera.office-code-package-observation/v1",
								observationId: args[3],
								provisionId: f.plan.provisionId,
								requestSha256: officeDigest(request),
								receipt,
								receiptSha256: officeDigest(receipt),
								inventorySha256: material.verified.inventorySha256,
							}
						: {
								schema: "qorpera.office-code-package-invocation/v1",
								challengeId: args[3],
								provisionId: f.plan.provisionId,
								activationId: challenge.activationId,
								startup: challenge.startup,
								receiptSha256: officeDigest(receipt),
								inventorySha256: material.verified.inventorySha256,
								service: material.verified.statement.target.service,
								runtimeBundle: material.verified.statement.target.runtimeBundle,
								evidence: { schema: "synthetic-physical-evidence" },
							};
				files.set(
					`${mode}-${args[3]}.json`,
					encode({ ...output, evidenceSha256: tamperObservation ? "f".repeat(64) : officeDigest(output) }),
				);
			}
			return {
				project: f.binding.project,
				instanceName: lxdOfficeGuestPlan(f.binding).request.name,
				operationId: randomUUID(),
			};
		},
	};
	const lane = new LxdOfficeCodePackageProvisionLane({
			root,
			binding: f.binding,
			material,
			client,
			registry,
			resetPlan: f.resetPlan,
		}),
		context = {
			resetPlan: f.resetPlan,
			custody: { synthetic: "custody" },
			restore: { synthetic: "restore" },
			restoreSha256: "b".repeat(64),
			bootId: randomUUID(),
			originalPreparation: Buffer.from('{"synthetic":"original"}'),
		},
		authorize = vi.fn(async () => {});
	return {
		f,
		root,
		material,
		files,
		actions,
		methods,
		client,
		registry,
		lane,
		context,
		authorize,
		ensure: () => lane.ensure(context, signal(), authorize),
		loseInstall: () => {
			loseInstall = true;
		},
		loseDispatch: () => {
			loseDispatch = true;
		},
		tamperObservation: () => {
			tamperObservation = true;
		},
	};
}
