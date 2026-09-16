import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLxdOfficeGuestInstance, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import {
	ensureLxdOfficeHostRebootReceipt,
	LxdOfficeHostRebootGate,
	lxdOfficeHostRebootAnchor,
	lxdOfficeHostRebootReceiptName,
	parseLxdOfficeRecoveryPlan,
	readLxdOfficeHostRebootReceipts,
} from "../src/lxd-office-host-reboot.ts";
import { officeCanonical } from "../src/lxd-office-image-provenance.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { officePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch() {
	// A journal root: a real path the publisher accepts (no symlinked tmpdir).
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-host-reboot-")));
	await chmod(root, 0o700);
	roots.push(root);
	return root;
}
const receipt = (allocationId: string, transitionId: string, shutdown: string, resumed: string) => ({
	schema: "qorpera.lxd-office-host-reboot/v1",
	intentId: id(1),
	allocationId,
	transitionId,
	shutdownHostBootId: shutdown,
	resumedHostBootId: resumed,
	recordedAtMs: 1000,
});

describe("host reboot receipts and the anchoring gate", () => {
	it("maps a resumed host boot back through every receipt to the original anchor", async () => {
		const root = await scratch();
		await publish(
			root,
			lxdOfficeHostRebootReceiptName(id(2), id(3)),
			Buffer.from(officeCanonical(receipt(id(2), id(3), id(10), id(11)))),
		);
		await publish(
			root,
			lxdOfficeHostRebootReceiptName(id(2), id(4)),
			Buffer.from(officeCanonical(receipt(id(2), id(4), id(10), id(12)))),
		);
		const receipts = await readLxdOfficeHostRebootReceipts(root);
		expect(receipts.size).toBe(2);
		expect(lxdOfficeHostRebootAnchor(receipts, id(11))).toBe(id(10));
		expect(lxdOfficeHostRebootAnchor(receipts, id(12))).toBe(id(10));
		expect(lxdOfficeHostRebootAnchor(receipts, id(13))).toBe(id(13));
		const inner = {
			policy: { journal: { path: root } } as never,
			check: vi.fn(async () => ({ signal: signal(), validForMs: 5000, hostBootId: id(12) })),
			inspect: vi.fn(async () => ({ signal: signal(), validForMs: 5000, hostBootId: id(12) })),
		};
		const gate = new LxdOfficeHostRebootGate(inner, root);
		expect((await gate.check({} as never, signal())).hostBootId).toBe(id(10));
		expect((await gate.inspect(signal())).hostBootId).toBe(id(10));
		expect(await gate.physical(signal())).toBe(id(12));
		expect(gate.policy).toBe(inner.policy);
	});
	it.each([
		["a receipt whose name differs from its content", receipt(id(2), id(9), id(10), id(11))],
		["a receipt resuming into its own anchor", receipt(id(2), id(3), id(10), id(10))],
		["a receipt with an unknown key", { ...receipt(id(2), id(3), id(10), id(11)), extra: 1 }],
	])("refuses %s", async (_name, value) => {
		const root = await scratch();
		await publish(root, lxdOfficeHostRebootReceiptName(id(2), id(3)), Buffer.from(officeCanonical(value)));
		await expect(readLxdOfficeHostRebootReceipts(root)).rejects.toThrow("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
	});
	it("refuses a receipt cycle instead of looping", () => {
		const receipts = new Map([
			[id(11), receipt(id(2), id(3), id(12), id(11))],
			[id(12), receipt(id(2), id(4), id(11), id(12))],
		]);
		expect(() => lxdOfficeHostRebootAnchor(receipts, id(11))).toThrow("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
	});
});

describe("recovery plan envelope", () => {
	async function request() {
		const f = await officePowerOffWorkerFixture(roots, "reboot");
		return f.request;
	}
	it("accepts the plain plan and the guard-marked host reboot plan", async () => {
		const r = await request();
		expect(
			parseLxdOfficeRecoveryPlan({ schema: "qorpera.lxd-office-recovery-plan/v1", request: r }).hostReboot,
		).toBeUndefined();
		const marked = parseLxdOfficeRecoveryPlan({
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: r,
			hostReboot: { shutdownHostBootId: id(10), requestedAtMs: 5 },
		});
		expect(marked.hostReboot).toEqual({ shutdownHostBootId: id(10), requestedAtMs: 5 });
		expect(marked.request).toEqual(r);
	});
	it("refuses another envelope key, a host reboot on a power_off request and a malformed marker", async () => {
		const r = await request();
		for (const value of [
			{ schema: "qorpera.lxd-office-recovery-plan/v1", request: r, note: 1 },
			{
				schema: "qorpera.lxd-office-recovery-plan/v1",
				request: { ...r, action: "power_off" },
				hostReboot: { shutdownHostBootId: id(10), requestedAtMs: 5 },
			},
			{
				schema: "qorpera.lxd-office-recovery-plan/v1",
				request: r,
				hostReboot: { shutdownHostBootId: "x", requestedAtMs: 5 },
			},
			{ schema: "qorpera.lxd-office-lifecycle-plan/v1", request: r },
		])
			expect(() => parseLxdOfficeRecoveryPlan(value)).toThrow();
	});
});

describe("ensureLxdOfficeHostRebootReceipt", () => {
	async function fixture() {
		const f = await officePowerOffWorkerFixture(roots, "reboot");
		await f.run();
		const done = JSON.parse(await readFile(f.paths.done, "utf8"));
		const plan = { shutdownHostBootId: done.hostBootId as string, requestedAtMs: 1 };
		const instance = { ...lxdOfficeGuestPlan(f.binding).request, status: "Stopped" };
		const client = {
			getInstance: vi.fn(async () => {
				const value = f.client.getInstance
					? await f.client.getInstance(f.binding.project, lxdOfficeGuestPlan(f.binding).request.name)
					: undefined;
				return value ?? (instance as never);
			}),
		};
		const registry = {
			call: vi.fn(async (method: string, args: Record<string, unknown>) => {
				expect(method).toBe("qorpera_record_runtime_office_host_reboot_resume");
				return {
					schema: "qorpera.office-host-reboot/v1",
					transitionId: (args.p_request as { transitionId: string }).transitionId,
					resumedHostBootId: args.p_resumed_host_boot_id,
					state: "resumed",
				};
			}),
		};
		return { f, plan, client, registry, done };
	}
	it("is a no-op on the anchoring host boot and publishes one receipt on a new one", async () => {
		const { f, plan, client, registry } = await fixture();
		const input = (physicalHostBootId: string) => ({
			root: f.root,
			intentId: f.activation.request.intentId,
			binding: f.binding,
			request: f.request,
			plan,
			physicalHostBootId,
			client: client as never,
			registry: registry as never,
		});
		expect(await ensureLxdOfficeHostRebootReceipt(input(plan.shutdownHostBootId), signal())).toBeUndefined();
		// The unchanged host is still recorded so the successor closes the row.
		expect(registry.call).toHaveBeenCalledTimes(1);
		expect(registry.call.mock.calls[0]?.[1]).toMatchObject({ p_resumed_host_boot_id: plan.shutdownHostBootId });
		registry.call.mockClear();
		const instance = await client.getInstance();
		assertLxdOfficeGuestInstance(f.binding, instance as never);
		const first = await ensureLxdOfficeHostRebootReceipt(input(id(77)), signal());
		expect(first).toMatchObject({ shutdownHostBootId: plan.shutdownHostBootId, resumedHostBootId: id(77) });
		expect(registry.call).toHaveBeenCalledTimes(1);
		const again = await ensureLxdOfficeHostRebootReceipt(input(id(77)), signal());
		expect(again).toEqual(first);
		expect(registry.call).toHaveBeenCalledTimes(2);
		const receipts = await readLxdOfficeHostRebootReceipts(f.root);
		expect(lxdOfficeHostRebootAnchor(receipts, id(77))).toBe(plan.shutdownHostBootId);
	});
	it("refuses a second, different host boot for the same transition", async () => {
		const { f, plan, client, registry } = await fixture();
		const input = (physicalHostBootId: string) => ({
			root: f.root,
			intentId: f.activation.request.intentId,
			binding: f.binding,
			request: f.request,
			plan,
			physicalHostBootId,
			client: client as never,
			registry: registry as never,
		});
		await ensureLxdOfficeHostRebootReceipt(input(id(77)), signal());
		// A physical id already mapped by a receipt anchors to the plan; a fresh
		// id with the receipt present differs from the retained receipt.
		await expect(ensureLxdOfficeHostRebootReceipt(input(id(78)), signal())).rejects.toThrow(
			"host reboot receipt differs",
		);
	});
	it("refuses a running guest, a missing guest and a plan anchor that differs", async () => {
		const { f, plan, client, registry } = await fixture();
		const base = {
			root: f.root,
			intentId: f.activation.request.intentId,
			binding: f.binding,
			request: f.request,
			plan,
			physicalHostBootId: id(77),
			client: client as never,
			registry: registry as never,
		};
		await expect(
			ensureLxdOfficeHostRebootReceipt({ ...base, plan: { ...plan, shutdownHostBootId: id(99) } }, signal()),
		).rejects.toThrow("host reboot power-off differs");
		const running = { getInstance: vi.fn(async () => ({ ...(await client.getInstance()), status: "Running" })) };
		await expect(ensureLxdOfficeHostRebootReceipt({ ...base, client: running as never }, signal())).rejects.toThrow(
			"host reboot VM not stopped",
		);
		const missing = { getInstance: vi.fn(async () => undefined) };
		await expect(ensureLxdOfficeHostRebootReceipt({ ...base, client: missing as never }, signal())).rejects.toThrow(
			"host reboot VM missing",
		);
		expect(registry.call).not.toHaveBeenCalled();
	});
});
