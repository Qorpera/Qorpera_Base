import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdOperationState, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { lxdOfficeDeleteDispositionPath } from "../src/lxd-office-delete-disposition.ts";
import { reconcileLxdOfficeDeleteMetadata } from "../src/lxd-office-delete-reconciliation.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import * as physical from "../src/lxd-office-physical-host.ts";
import { LxdOfficeResetJournal } from "../src/lxd-office-reset-journal.ts";
import { testAgentMac } from "./helpers/agent-plug.ts";
import {
	officeDeleteDispositionId as id,
	officeDeleteDispositionContextFor,
	officeDeleteDispositionFixture,
} from "./helpers/office-delete-disposition-fixture.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-delete-reconciliation-")));
	roots.push(root);
	await chmod(root, 0o700);
	const { plan, document } = officeDeleteDispositionFixture();
	const startup = plan.predecessor.startup;
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		...startup.scope,
		computerGeneration: startup.computerGeneration,
		allocationId: startup.allocationId,
		providerId: plan.predecessor.providerId,
		providerPolicySha256: plan.predecessor.providerPolicySha256,
		project: "offices",
		imageFingerprint: startup.imageSha256,
		bootstrapSha256: startup.bootstrapSha256,
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	};
	Object.assign(plan, { providerBindingSha256: officeDigest(binding) });
	document.planSha256 = officeDigest(plan);
	const guest = lxdOfficeGuestPlan(binding);
	let counter = 100;
	const client = {
		submitInstanceOperation: vi.fn(async (project: string, _action: LxdTrackedInstanceAction) => ({
			project,
			instanceName: guest.request.name,
			operationId: id(counter++),
		})),
		inspectInstanceOperation: vi.fn(async (): Promise<LxdOperationState> => "succeeded"),
	};
	const journal = await LxdOfficeOperationJournal.open(root, plan.intentId, binding, client);
	for (const [command, action] of [
		[id(90), "create"],
		[id(91), "start"],
		[plan.commands.stopCommandId, "stop"],
	] as const)
		await journal.reconcile(command, action, signal(), action === "create" ? testAgentMac : undefined);
	client.inspectInstanceOperation.mockRejectedValue(new Error("result evicted"));
	const unknown = await journal.reconcile(plan.commands.deleteCommandId, "delete", signal());
	expect(unknown.state).toBe("unknown");
	const dir = join(root, startup.allocationId);
	document.operationId = unknown.operationId!;
	document.journal = {
		authoritySha256: hash(await readFile(join(dir, "authority.json"))),
		acceptedHeadSha256: hash(await readFile(join(dir, "000010.json"))),
		eventCount: 11,
	};
	const phases = await LxdOfficeResetJournal.open(root, plan);
	for (const [phase, digest] of [
		["fenced", officeDigest(plan)],
		["stopped", document.stopAcknowledgementSha256],
		["custodied", document.custodyEvidenceSha256],
		["powered_off", document.poweredOffPhaseSha256],
	] as const)
		await phases.advance(phase, digest);
	const { context, bytes } = await officeDeleteDispositionContextFor(plan, document);
	const path = lxdOfficeDeleteDispositionPath(startup.allocationId, document.auditId);
	const protectedRead = vi.spyOn(physical, "readLxdOfficeProtectedFile").mockImplementation(async (requested) => {
		if (requested !== path) throw new Error("unknown protected file");
		return bytes;
	});
	const saved = new Map<string, Buffer>();
	for (const name of await readdir(dir)) saved.set(join(dir, name), await readFile(join(dir, name)));
	for (const name of await readdir(root))
		if (name.endsWith(".json")) saved.set(join(root, name), await readFile(join(root, name)));
	const preserved = async () => {
		for (const [path, bytes] of saved) expect(await readFile(path)).toEqual(bytes);
	};
	const phase5 = join(root, `reset-phase-${startup.allocationId}-${plan.resetId}-5.json`);
	return { root, dir, plan, context, client, journal, protectedRead, preserved, phase5 };
}

describe("administrative delete metadata crash reconciliation", () => {
	it("publishes the distinct marker then phase5 once, preserving all original bytes and the unknown operation", async () => {
		const f = await fixture();
		const boundary = vi.fn(async () => {});
		const calls = f.client.inspectInstanceOperation.mock.calls.length;
		const first = await reconcileLxdOfficeDeleteMetadata(f.root, f.context, boundary);
		const marker = await readFile(join(f.dir, "000011.json")),
			phase = await readFile(f.phase5);
		expect(first).toMatchObject({
			originalOutcome: "unknown",
			cleanResetAcceptance: false,
			vmOperationRequested: false,
			metadataComplete: true,
		});
		expect(await reconcileLxdOfficeDeleteMetadata(f.root, f.context, boundary)).toEqual(first);
		expect(await readFile(join(f.dir, "000011.json"))).toEqual(marker);
		expect(await readFile(f.phase5)).toEqual(phase);
		await expect(f.journal.observe(f.plan.commands.deleteCommandId, "delete", signal())).resolves.toEqual({
			state: "unknown",
			operationId: f.context.document.operationId,
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(calls);
		await f.preserved();
	});

	it.each([1, 2, 3, 4, 5])("recovers only missing metadata after publication boundary failure %s", async (failAt) => {
		const f = await fixture();
		let at = 0;
		await expect(
			reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {
				if (++at === failAt) throw new Error("boundary failed");
			}),
		).rejects.toThrow("boundary failed");
		const count = (await f.journal.history()).events.length;
		expect(count).toBe(failAt < 3 ? 11 : 12);
		if (failAt <= 3) {
			await expect(readFile(f.phase5)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				f.journal.reconcile(f.plan.commands.createCommandId, "create", signal(), testAgentMac),
			).rejects.toThrow();
		}
		await f.preserved();
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {})).resolves.toMatchObject({
			metadataComplete: true,
		});
		expect((await f.journal.history()).events).toHaveLength(12);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		await f.preserved();
	});

	it("refuses phase5 without its preceding marker and leaves it unchanged", async () => {
		const f = await fixture();
		await (await LxdOfficeResetJournal.open(f.root, f.plan)).advance("root_deleted", f.context.phaseEvidenceSha256);
		const bytes = await readFile(f.phase5);
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {})).rejects.toThrow("TAIL_DIFFERS");
		expect(await readFile(f.phase5)).toEqual(bytes);
		expect((await f.journal.history()).events).toHaveLength(11);
	});

	it("refuses an altered SQL/root receipt before marker publication", async () => {
		const f = await fixture();
		f.protectedRead.mockRejectedValue(new Error("protected receipt absent"));
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {})).rejects.toThrow(
			"DISPOSITION_UNCONFIRMED",
		);
		expect((await f.journal.history()).events).toHaveLength(11);
		await f.preserved();
	});

	it("does not overwrite a corrupt published phase after a lost reply", async () => {
		const f = await fixture();
		await reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {});
		await writeFile(f.phase5, '{"partial":');
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {})).rejects.toThrow();
		expect(await readFile(f.phase5, "utf8")).toBe('{"partial":');
		expect((await f.journal.history()).events).toHaveLength(12);
	});

	it("refuses later phase history instead of replaying an old operator action", async () => {
		const f = await fixture();
		await reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {});
		await (await LxdOfficeResetJournal.open(f.root, f.plan)).advance("root_created", "a".repeat(64));
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {})).rejects.toThrow(
			"PHASE_DIFFERS",
		);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
	});

	it("permits only the exact planned create after complete metadata and never retries the unknown delete", async () => {
		const f = await fixture();
		await reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {});
		for (const [command, action] of [
			[id(240), "create"],
			[f.plan.commands.createCommandId, "start"],
			[id(241), "delete"],
		] as const)
			await expect(
				f.journal.reconcile(command, action, signal(), action === "create" ? testAgentMac : undefined),
			).rejects.toThrow();
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		const observed = f.client.inspectInstanceOperation.mock.calls.length;
		await expect(f.journal.reconcile(f.plan.commands.deleteCommandId, "delete", signal())).resolves.toEqual({
			state: "unknown",
			operationId: f.context.document.operationId,
		});
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(observed);
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		await expect(
			f.journal.reconcile(f.plan.commands.createCommandId, "create", signal(), testAgentMac),
		).resolves.toMatchObject({
			state: "succeeded",
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(5);
		await f.preserved();
		expect((await f.journal.history()).events[11]).toMatchObject({
			kind: "administrative_disposition",
			state: "unknown",
		});
	});

	it("refuses new dispatch when the protected disposition disappears after metadata publication", async () => {
		const f = await fixture();
		await reconcileLxdOfficeDeleteMetadata(f.root, f.context, async () => {});
		f.protectedRead.mockRejectedValue(new Error("receipt unavailable"));
		await expect(
			f.journal.reconcile(f.plan.commands.createCommandId, "create", signal(), testAgentMac),
		).rejects.toThrow("DISPOSITION_UNCONFIRMED");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		expect((await f.journal.history()).events).toHaveLength(12);
		await f.preserved();
	});

	it("rejects a cloned receipt context without publishing metadata", async () => {
		const f = await fixture();
		await expect(reconcileLxdOfficeDeleteMetadata(f.root, { ...f.context }, async () => {})).rejects.toThrow(
			"CONTEXT_UNVERIFIED",
		);
		expect((await f.journal.history()).events).toHaveLength(11);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		await f.preserved();
	});
});
