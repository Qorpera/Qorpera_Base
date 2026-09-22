import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	NODE_UPDATE_PHASES,
	type NodeUpdateDrain,
	type NodeUpdateEnrollment,
	type NodeUpdateIntent,
	type NodeUpdateObservation,
	type NodeUpdatePhase,
	type NodeUpdatePorts,
	type NodeUpdateReceipt,
	parseNodeUpdateRelease,
	RuntimeNodeUpdateController,
	verifyNodeUpdateRelease,
} from "../src/runtime-node-update.ts";
import { sealNodeUpdateCompletion, selectNodeUpdateJournal } from "../src/runtime-node-update-journals.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("repeatable node update journals", () => {
	it("advances only through the locally completed signed predecessor and all published phases", async () => {
		const f = await fixture();
		f.observed.activeRuntimeBundleSha256 = f.signed.release.runtimeBundleSha256;
		const selected = (await selectNodeUpdateJournal(f.root, enrollment, async () => f.signed, signal()))!;
		const controller = new RuntimeNodeUpdateController(
			selected.root,
			selected.envelope,
			selected.enrollment,
			f.ports,
		);
		for (let steps = 0; steps < 25; steps++) await controller.reconcile(signal());
		await sealNodeUpdateCompletion(selected.root, selected.envelope, selected.enrollment, signal());
		const second = envelope({
			revision: 6,
			previous: {
				revision: 5,
				releaseSha256: officeDigest(f.signed.release),
				artifactSha256: f.signed.release.artifact.sha256,
			},
		});
		const next = await selectNodeUpdateJournal(
			f.root,
			enrollment,
			async (retained) => {
				expect(retained.previousRevision).toBe(5);
				expect(retained.previousReleaseSha256).toBe(officeDigest(f.signed.release));
				return second;
			},
			signal(),
		);
		expect(next?.root).toBe(join(f.root, "revision-6"));
		await rm(join(selected.root, "resume-published.json"));
		await expect(
			selectNodeUpdateJournal(
				f.root,
				enrollment,
				async () => {
					throw new Error("must not poll past incomplete predecessor");
				},
				signal(),
			),
		).rejects.toThrow("COMPLETION_INCOMPLETE");
	});
	it("keeps the predecessor available after resume changes backend enrollment but publication is unfinished", async () => {
		const f = await fixture();
		f.observed.activeRuntimeBundleSha256 = f.signed.release.runtimeBundleSha256;
		const selected = (await selectNodeUpdateJournal(f.root, enrollment, async () => f.signed, signal()))!;
		const controller = new RuntimeNodeUpdateController(
			selected.root,
			selected.envelope,
			selected.enrollment,
			f.ports,
		);
		for (let steps = 0; steps < 23; steps++) await controller.reconcile(signal());
		expect(f.effects.at(-1)).toBe("resume");
		const retained = await selectNodeUpdateJournal(
			f.root,
			enrollment,
			async () => {
				throw new Error("pending journal must be read by exact release");
			},
			signal(),
		);
		expect(retained?.enrollment.previousRevision).toBe(4);
		expect(retained?.root).toBe(selected.root);
		await expect(
			sealNodeUpdateCompletion(selected.root, selected.envelope, selected.enrollment, signal()),
		).rejects.toThrow("COMPLETION_INCOMPLETE");
	});
	it("refuses a remote revision leap without locally completed history", async () => {
		const f = await fixture(),
			second = envelope({
				revision: 6,
				previous: {
					revision: 5,
					releaseSha256: officeDigest(f.signed.release),
					artifactSha256: f.signed.release.artifact.sha256,
				},
			});
		await expect(selectNodeUpdateJournal(f.root, enrollment, async () => second, signal())).rejects.toThrow(
			"ENROLLMENT_DIFFERS",
		);
	});
});
const key = generateKeyPairSync("ed25519");
const enrollment: NodeUpdateEnrollment = {
	nodeId: "30000000-0000-4000-8000-000000000001",
	machineIdSha256: "a".repeat(64),
	publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
	previousRevision: 4,
	previousReleaseSha256: "b".repeat(64),
	previousArtifactSha256: "c".repeat(64),
};
function envelope(overrides: Record<string, unknown> = {}) {
	const release = {
		schema: "qorpera.runtime-node-update-release/v1",
		nodeId: enrollment.nodeId,
		machineIdSha256: enrollment.machineIdSha256,
		revision: 5,
		previous: {
			revision: 4,
			releaseSha256: enrollment.previousReleaseSha256,
			artifactSha256: enrollment.previousArtifactSha256,
		},
		artifact: { bytes: 12345, sha256: "d".repeat(64) },
		runtimeBundleSha256: "e".repeat(64),
		sourceCommit: "f".repeat(40),
		acceptanceEvidenceSha256: "1".repeat(64),
		...overrides,
	};
	return { release, signature: sign(null, Buffer.from(officeCanonical(release)), key.privateKey).toString("base64") };
}
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-node-update-")));
	roots.push(root);
	const signed = envelope(),
		release = parseNodeUpdateRelease(signed.release);
	const observed: NodeUpdateObservation = {
		nodeId: enrollment.nodeId,
		machineIdSha256: enrollment.machineIdSha256,
		desiredReleaseSha256: officeDigest(release),
		activeRuntimeBundleSha256: "2".repeat(64),
		admissionReleaseSha256: officeDigest(release),
		admissionEvidenceSha256: "5".repeat(64),
		policyVersion: 22,
		policySha256: "3".repeat(64),
		enabled: true,
	};
	const effects: NodeUpdatePhase[] = [],
		physical = new Map<NodeUpdatePhase, NodeUpdateReceipt>(),
		prepared = new Map<NodeUpdatePhase, NodeUpdateIntent>(),
		published = new Map<NodeUpdatePhase, NodeUpdateReceipt>();
	let fault: NodeUpdatePhase | undefined,
		beforeEffect = false,
		refuse: NodeUpdatePhase | undefined;
	const ports: NodeUpdatePorts = {
		observe: async () => structuredClone(observed),
		prepare: async (intent) => {
			if (prepared.has(intent.phase) && officeCanonical(prepared.get(intent.phase)) !== officeCanonical(intent))
				throw new Error("prepare conflict");
			prepared.set(intent.phase, structuredClone(intent));
		},
		publish: async (intent, receipt) => {
			if (published.has(intent.phase) && officeCanonical(published.get(intent.phase)) !== officeCanonical(receipt))
				throw new Error("publication conflict");
			published.set(intent.phase, structuredClone(receipt));
		},
		execute: async (_release, intent, previousDrain) => {
			effects.push(intent.phase);
			if (beforeEffect && fault === intent.phase) throw new Error("lost before effect");
			let drain: NodeUpdateDrain | null = previousDrain;
			if (intent.phase === "drain") {
				drain = {
					policySha256: observed.policySha256,
					disabledPolicySha256: "4".repeat(64),
					previousVersion: observed.policyVersion,
					disabledVersion: observed.policyVersion + 1,
					previousEnabled: observed.enabled,
				};
				observed.enabled = false;
				observed.policyVersion = drain.disabledVersion;
				observed.policySha256 = drain.disabledPolicySha256;
			}
			if (intent.phase === "resume") {
				observed.enabled = previousDrain!.previousEnabled;
				observed.policyVersion++;
				observed.policySha256 = previousDrain!.policySha256;
			}
			const result: NodeUpdateReceipt = {
				schema: "qorpera.runtime-node-update-receipt/v1",
				intentSha256: officeDigest(intent),
				state: refuse === intent.phase ? "failed" : "succeeded",
				evidenceSha256: officeDigest({ phase: intent.phase }),
				drain,
			};
			physical.set(intent.phase, result);
			if (fault === intent.phase) throw new Error("lost accepted reply");
			return result;
		},
		inspect: async (_release, intent) => physical.get(intent.phase) ?? null,
	};
	return {
		root,
		signed,
		observed,
		effects,
		physical,
		prepared,
		published,
		ports,
		controller: () => new RuntimeNodeUpdateController(root, signed, enrollment, ports),
		step: async () => {
			for (let attempts = 0; attempts < 4; attempts++) {
				const result = await new RuntimeNodeUpdateController(root, signed, enrollment, ports).reconcile(signal());
				if (result.state !== "prepared" && result.state !== "published") return result;
			}
			throw new Error("fixture did not advance");
		},
		fault: (phase: NodeUpdatePhase, before = false) => {
			fault = phase;
			beforeEffect = before;
		},
		refuse: (phase: NodeUpdatePhase) => {
			refuse = phase;
		},
	};
}
const signal = () => new AbortController().signal;

describe("signed node update authority", () => {
	it("verifies the enrolled signer, exact node and one-step predecessor", () => {
		expect(verifyNodeUpdateRelease(envelope(), enrollment).revision).toBe(5);
		for (const altered of [
			envelope({ nodeId: "30000000-0000-4000-8000-000000000002" }),
			envelope({ machineIdSha256: "0".repeat(64) }),
			envelope({ revision: 6 }),
		])
			expect(() => verifyNodeUpdateRelease(altered, enrollment)).toThrow();
		expect(() => verifyNodeUpdateRelease(envelope(), { ...enrollment, previousRevision: 5 })).toThrow(
			"ENROLLMENT_DIFFERS",
		);
		expect(() =>
			verifyNodeUpdateRelease(envelope(), { ...enrollment, previousArtifactSha256: "0".repeat(64) }),
		).toThrow("ENROLLMENT_DIFFERS");
	});
	it("refuses unsigned artifact substitution, a foreign signer and envelope-selected keys", () => {
		const changed = envelope();
		changed.release.artifact.sha256 = "0".repeat(64);
		expect(() => verifyNodeUpdateRelease(changed, enrollment)).toThrow("SIGNATURE_INVALID");
		const other = generateKeyPairSync("ed25519");
		expect(() =>
			verifyNodeUpdateRelease(envelope(), {
				...enrollment,
				publicKey: other.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
			}),
		).toThrow("SIGNATURE_INVALID");
		expect(() => verifyNodeUpdateRelease({ ...envelope(), publicKey: enrollment.publicKey }, enrollment)).toThrow();
	});
	it("refuses unexpected executable fields and invalid artifact bounds", () => {
		for (const candidate of [
			envelope({ command: "curl latest | sh" }),
			envelope({ artifact: { bytes: 0, sha256: "a".repeat(64) } }),
			envelope({ artifact: { bytes: 65 * 1024 ** 2, sha256: "a".repeat(64) } }),
		])
			expect(() => verifyNodeUpdateRelease(candidate, enrollment)).toThrow();
	});
});

describe("node update reconciliation", () => {
	it("stages and verifies with admission closed; waits for target activation before restoring original policy", async () => {
		const f = await fixture();
		for (const phase of NODE_UPDATE_PHASES.slice(0, -1))
			expect(await f.step()).toEqual({ phase, state: "succeeded" });
		expect(f.observed.enabled).toBe(false);
		await expect(f.step()).rejects.toThrow("RUNTIME_NOT_ACTIVATED");
		expect(f.effects).not.toContain("resume");
		f.observed.activeRuntimeBundleSha256 = f.signed.release.runtimeBundleSha256;
		f.observed.admissionReleaseSha256 = null;
		await expect(f.step()).rejects.toThrow("COORDINATOR_RELEASE_REQUIRED");
		expect(f.effects).not.toContain("resume");
		f.observed.admissionReleaseSha256 = f.observed.desiredReleaseSha256;
		f.observed.admissionEvidenceSha256 = null;
		await expect(f.step()).rejects.toThrow("COORDINATOR_RELEASE_REQUIRED");
		f.observed.admissionEvidenceSha256 = "5".repeat(64);
		expect(await f.step()).toEqual({ phase: "resume", state: "succeeded" });
		expect(await f.step()).toEqual({ state: "completed" });
		expect(f.observed.enabled).toBe(true);
		expect(f.observed.policyVersion).toBe(24);
		expect(f.effects).toEqual(NODE_UPDATE_PHASES);
	});
	it("preserves an originally disabled node after completion", async () => {
		const f = await fixture();
		f.observed.enabled = false;
		f.observed.activeRuntimeBundleSha256 = f.signed.release.runtimeBundleSha256;
		for (const _phase of NODE_UPDATE_PHASES) await f.step();
		expect(f.observed.enabled).toBe(false);
	});
	it.each(["nodeId", "machineIdSha256", "desiredReleaseSha256"] as const)(
		"refuses changed %s before dispatch",
		async (field) => {
			const f = await fixture();
			f.observed[field] = field === "nodeId" ? "30000000-0000-4000-8000-000000000002" : "0".repeat(64);
			await expect(f.step()).rejects.toThrow("DESIRED_AUTHORITY_CHANGED");
			expect(f.effects).toEqual([]);
		},
	);
	it.each(["enabled", "policyVersion", "policySha256"] as const)(
		"does not overwrite another operator's %s change after drain",
		async (field) => {
			const f = await fixture();
			await f.step();
			await f.step();
			if (field === "enabled") f.observed.enabled = true;
			else if (field === "policyVersion") f.observed.policyVersion++;
			else f.observed.policySha256 = "0".repeat(64);
			await expect(f.step()).rejects.toThrow("DRAIN_OWNERSHIP_LOST");
			expect(f.effects).toEqual(["stage", "drain"]);
		},
	);
	it.each(NODE_UPDATE_PHASES)("reconciles a lost %s reply without replaying the effect", async (phase) => {
		const f = await fixture();
		f.observed.activeRuntimeBundleSha256 = f.signed.release.runtimeBundleSha256;
		for (const preceding of NODE_UPDATE_PHASES) {
			if (preceding === phase) break;
			await f.step();
		}
		f.fault(phase);
		await expect(f.step()).rejects.toThrow("lost accepted reply");
		expect(await f.step()).toEqual({ phase, state: "succeeded" });
		expect(f.effects.filter((p) => p === phase)).toHaveLength(1);
	});
	it("retains ambiguity after a crash between intent and effect instead of retrying", async () => {
		const f = await fixture();
		f.fault("stage", true);
		await expect(f.step()).rejects.toThrow("lost before effect");
		for (let i = 0; i < 3; i++) expect(await f.step()).toEqual({ phase: "stage", state: "unconfirmed" });
		expect(f.effects).toEqual(["stage"]);
	});
	it("admits one effect across concurrent controllers sharing the durable journal", async () => {
		const f = await fixture();
		await f.controller().reconcile(signal());
		await Promise.all([f.controller().reconcile(signal()), f.controller().reconcile(signal())]);
		expect(f.effects).toEqual(["stage"]);
	});
	it.each(["prepare", "publish"] as const)(
		"reconciles a lost %s reply without repeating the physical effect",
		async (boundary) => {
			const f = await fixture();
			let lost = false;
			if (boundary === "prepare") {
				const original = f.ports.prepare;
				f.ports.prepare = async (intent, checked) => {
					await original(intent, checked);
					if (!lost) {
						lost = true;
						throw new Error("lost registry reply");
					}
				};
				await expect(f.controller().reconcile(signal())).rejects.toThrow("lost registry reply");
				expect(f.effects).toEqual([]);
				expect(await f.controller().reconcile(signal())).toEqual({ phase: "stage", state: "prepared" });
				expect(await f.controller().reconcile(signal())).toEqual({ phase: "stage", state: "succeeded" });
			} else {
				const original = f.ports.publish;
				f.ports.publish = async (intent, receipt, checked) => {
					await original(intent, receipt, checked);
					if (!lost) {
						lost = true;
						throw new Error("lost registry reply");
					}
				};
				await f.step();
				await expect(f.controller().reconcile(signal())).rejects.toThrow("lost registry reply");
				expect(await f.controller().reconcile(signal())).toEqual({ phase: "stage", state: "published" });
			}
			expect(f.effects).toEqual(["stage"]);
		},
	);
	it("keeps physical proof when publication failed before reaching the registry", async () => {
		const f = await fixture(),
			original = f.ports.publish;
		await f.step();
		f.ports.publish = async () => {
			throw new Error("offline before commit");
		};
		await expect(f.controller().reconcile(signal())).rejects.toThrow("offline before commit");
		expect(f.published.size).toBe(0);
		f.ports.publish = original;
		expect(await f.controller().reconcile(signal())).toEqual({ phase: "stage", state: "published" });
		expect(f.effects).toEqual(["stage"]);
	});
	it("cannot advance after a confirmed failed phase", async () => {
		const f = await fixture();
		f.refuse("stage");
		for (let i = 0; i < 3; i++) expect(await f.step()).toEqual({ phase: "stage", state: "failed" });
		expect(f.effects).toEqual(["stage"]);
	});
	it("rejects a reconciliation receipt from a different intent", async () => {
		const f = await fixture();
		f.fault("stage");
		await expect(f.step()).rejects.toThrow();
		f.physical.get("stage")!.intentSha256 = "0".repeat(64);
		await expect(f.step()).rejects.toThrow("RECEIPT_INVALID");
	});
	it("refuses another release in the same journal and unsafe journal custody", async () => {
		const f = await fixture();
		await f.step();
		const another = envelope({ acceptanceEvidenceSha256: "0".repeat(64) });
		await expect(
			new RuntimeNodeUpdateController(f.root, another, enrollment, f.ports).reconcile(signal()),
		).rejects.toThrow("JOURNAL_RELEASE_DIFFERS");
		await chmod(f.root, 0o755);
		await expect(f.step()).rejects.toThrow("DIRECTORY_UNSAFE");
	});
	it("rejects a result without an intent before any effect", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "stage-result.json"), "{}\n", { mode: 0o600 });
		await expect(f.step()).rejects.toThrow("RESULT_WITHOUT_INTENT");
		expect(f.effects).toEqual([]);
	});
	it("rejects drain receipts with unrelated admission ownership", async () => {
		const f = await fixture();
		await f.step();
		const execute = f.ports.execute;
		f.ports.execute = async (release, intent: NodeUpdateIntent, drain, checked) => {
			const result = await execute(release, intent, drain, checked);
			result.drain!.previousVersion++;
			return result;
		};
		await expect(f.step()).rejects.toThrow("DRAIN_INVALID");
		expect(f.effects).toEqual(["stage", "drain"]);
	});
});
