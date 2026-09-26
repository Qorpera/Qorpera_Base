import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaidComputerPermit } from "../src/computer-paid-guard.ts";
import type { LxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import {
	openLxdOfficeCurrentOperationJournal,
	readLxdOfficeOutageVmLineage,
	retainOutageRecord,
} from "../src/lxd-office-outage-history.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-outage-lineage-")));
	roots.push(root);
	const { binding } = officePhysicalFixture(),
		plan = lxdOfficeGuestPlan(binding);
	const creation: LxdOfficeCreationIdentity = {
		schema: "qorpera.lxd-office-creation/v1",
		intentId: randomUUID(),
		binding,
		createCommandId: randomUUID(),
	};
	const client = {
		submitInstanceOperation: vi.fn(async (project: string) => ({
			project,
			instanceName: plan.request.name,
			operationId: randomUUID(),
		})),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
	};
	const signal = new AbortController().signal,
		journal = await LxdOfficeOperationJournal.open(root, creation.intentId, binding, client);
	await journal.reconcile(creation.createCommandId, "create", signal);
	await journal.reconcile(randomUUID(), "start", signal);
	const bridge = async (predecessorRoot: string) => {
		const previous = await LxdOfficeOperationJournal.readHistory(predecessorRoot, binding.allocationId),
			start = previous.events.at(-1)!;
		const recoveryId = randomUUID(),
			startCommandId = randomUUID(),
			hostBootId = randomUUID(),
			physicalId = randomUUID(),
			guestBootId = randomUUID();
		const permit: PaidComputerPermit = {
			schema: "qorpera.computer-usage-permit/v2",
			prestart: { guardIncarnationId: randomUUID(), prepareSha256: "a".repeat(64) },
			mode: "paid",
			permitId: start.commandId,
			allocationId: binding.allocationId,
			instanceSha256: plan.instanceSha256,
			nodeId: randomUUID(),
			epoch: randomUUID(),
			generation: 1,
			reservationId: randomUUID(),
			hostBootId,
			guestBootId,
			physicalId,
			issuedAt: "2026-09-26T12:00:00.000Z",
			state: "bound",
			deadline: "2026-09-26T12:05:30.000Z",
			validForMs: 330000,
			windowMs: 300000,
			stopReserveMs: 30000,
			tariffVersion: 1,
			cpuMillis: 2000,
			memoryBytes: 2147483648,
		};
		const proof = {
			permit,
			hostMachineIdSha256: "b".repeat(64),
			physicalInstanceId: physicalId,
			startOperationId: start.operationId,
			startDispatched: true,
			startSettled: true,
			startSucceeded: true,
			stopReceipt: {
				permitId: permit.permitId,
				generation: 1,
				allocationId: binding.allocationId,
				instanceSha256: plan.instanceSha256,
				physicalInstanceId: physicalId,
				hostBootId,
				observedUptimeMs: 500000,
				closedAtUptimeMs: 500001,
				closedHostBootId: hostBootId,
				state: "stopped",
				operationId: randomUUID(),
			},
		};
		const outageRequest = {
			schema: "qorpera.office-computer-outage-request/v1",
			requestId: randomUUID(),
			guard: proof,
			activation: {
				activationId: randomUUID(),
				providerId: binding.providerId,
				providerPolicySha256: binding.providerPolicySha256,
				startup: {
					scope: {
						companyId: binding.companyId,
						environmentId: binding.environmentId,
						companyComputerId: binding.companyComputerId,
						logicalComputerId: binding.logicalComputerId,
					},
					computerGeneration: binding.computerGeneration,
					allocationId: binding.allocationId,
					instanceSha256: plan.instanceSha256,
					imageSha256: binding.imageFingerprint,
					bootstrapSha256: binding.bootstrapSha256,
					bootId: guestBootId,
					configurationSha256: "c".repeat(64),
					serviceInvocationId: "d".repeat(32),
				},
			},
		};
		const outage = {
			schema: "qorpera.office-computer-outage/v1",
			request: outageRequest,
			state: "held",
			officeRevision: 3,
			registeredAtMs: 1,
		};
		const request = {
			schema: "qorpera.office-outage-recovery-request/v1",
			recoveryId,
			outageRequestId: outageRequest.requestId,
			activationId: randomUUID(),
			startCommandId,
		};
		const record = {
			schema: "qorpera.lxd-office-outage-history/v1",
			intentId: creation.intentId,
			binding,
			request,
			outageSha256: officeDigest(outage),
			predecessorJournalHeadSha256: previous.journalHeadSha256,
			externalStop: proof,
		};
		const suffix = `${binding.allocationId}-${permit.permitId}`,
			name = `outage-recovery-${suffix}.json`,
			segmentRoot = join(root, `outage-vm-${recoveryId}`);
		await retainOutageRecord(root, `paid-outage-request-${suffix}.json`, outageRequest);
		await retainOutageRecord(root, `paid-outage-receipt-${suffix}.json`, outage);
		await mkdir(segmentRoot, { mode: 0o700 });
		const segment = await LxdOfficeOperationJournal.open(segmentRoot, creation.intentId, binding, client);
		await retainOutageRecord(root, name, record);
		await segment.reconcile(startCommandId, "start", signal);
		return { record, name, segmentRoot, segment, startCommandId };
	};
	return { root, creation, client, journal, bridge, signal };
}
describe("immutable office outage VM segments", () => {
	it("validates ordinary stop/resume/reset against the explicit outage segment origin", async () => {
		const f = await fixture(),
			first = await f.bridge(f.root);
		const selected = await openLxdOfficeCurrentOperationJournal(f.root, f.creation, f.client);
		const start = { commandId: first.startCommandId, action: "start" as const };
		await selected.journal.assertRetainedLifecycleSequence([start], f.signal);
		const stop = { commandId: randomUUID(), action: "stop" as const };
		await selected.journal.assertRetainedLifecycleSequence([start, stop], f.signal);
		await selected.journal.reconcile(stop.commandId, "stop", f.signal);
		const resume = { commandId: randomUUID(), action: "start" as const };
		await selected.journal.assertRetainedLifecycleSequence([start, stop, resume], f.signal);
		await selected.journal.reconcile(resume.commandId, "start", f.signal);
		const prior = [start, stop, resume],
			reset = {
				stopCommandId: randomUUID(),
				deleteCommandId: randomUUID(),
				createCommandId: randomUUID(),
				startCommandId: randomUUID(),
			};
		expect(await selected.journal.assertResetLineage(prior, reset, f.signal)).toEqual({
			reached: "none",
			settled: false,
		});
		for (const [commandId, action] of [
			[reset.stopCommandId, "stop"],
			[reset.deleteCommandId, "delete"],
			[reset.createCommandId, "create"],
			[reset.startCommandId, "start"],
		] as const) {
			await selected.journal.reconcile(commandId, action, f.signal);
			expect(await selected.journal.assertResetLineage(prior, reset, f.signal)).toEqual({
				reached: action,
				settled: true,
			});
		}
		await selected.assertCurrent();
		await expect(f.journal.assertRetainedLifecycleSequence([start], f.signal)).rejects.toThrow(
			"OFFICE_VM_LINEAGE_UNCONFIRMED",
		);
		await f.bridge(first.segmentRoot);
		await expect(selected.assertCurrent()).rejects.toThrow("OFFICE_VM_SEGMENT_SUPERSEDED");
	});
	it("follows consecutive outages and later real stop/start operations without inventing a stop", async () => {
		const f = await fixture(),
			original = await readLxdOfficeOutageVmLineage(f.root, f.creation);
		expect(original.segmentRoot).toBe(f.root);
		const first = await f.bridge(f.root),
			second = await f.bridge(first.segmentRoot);
		const current = await readLxdOfficeOutageVmLineage(f.root, f.creation);
		expect(current.segmentRoot).toBe(second.segmentRoot);
		expect(current.segments).toHaveLength(3);
		expect(
			current.segments.flatMap((segment) => segment.history.events).some((event) => event.action === "stop"),
		).toBe(false);
		await second.segment.reconcile(randomUUID(), "stop", f.signal);
		await second.segment.reconcile(randomUUID(), "start", f.signal);
		const third = await f.bridge(second.segmentRoot);
		expect((await readLxdOfficeOutageVmLineage(f.root, f.creation)).segmentRoot).toBe(third.segmentRoot);
		expect((await f.journal.history()).journalHeadSha256).toBe(original.history.journalHeadSha256);
	});
	it("refuses a changed predecessor journal instead of silently selecting old main history", async () => {
		const f = await fixture();
		await f.bridge(f.root);
		await f.journal.reconcile(randomUUID(), "stop", f.signal);
		await expect(readLxdOfficeOutageVmLineage(f.root, f.creation)).rejects.toThrow(
			"OFFICE_OUTAGE_LINEAGE_UNCONFIRMED",
		);
	});
	it("refuses a changed original external stop receipt", async () => {
		const f = await fixture(),
			first = await f.bridge(f.root),
			path = join(f.root, first.name);
		const record = JSON.parse(await readFile(path, "utf8")) as {
			externalStop: { stopReceipt: { operationId: string } };
		};
		record.externalStop.stopReceipt.operationId = randomUUID();
		await writeFile(path, JSON.stringify(record), { mode: 0o600 });
		await expect(readLxdOfficeOutageVmLineage(f.root, f.creation)).rejects.toThrow("OFFICE_OUTAGE_BRIDGE_DIFFERS");
	});
	it("refuses a lost segment rather than recreating operation authority", async () => {
		const f = await fixture(),
			first = await f.bridge(f.root);
		await rm(join(first.segmentRoot, f.creation.binding.allocationId, "authority.json"));
		await expect(readLxdOfficeOutageVmLineage(f.root, f.creation)).rejects.toThrow();
	});
});
