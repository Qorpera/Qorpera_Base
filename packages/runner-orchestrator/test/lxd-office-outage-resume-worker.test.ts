import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeOutageWorkerFixture } from "./fixtures/office-outage-worker.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
const fixture = () => officeOutageWorkerFixture(roots);
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
describe("paid outage cold boot", () => {
	it.each(["resume", "admission"] as const)(
		"retains %s ownership after cancellation until the underlying RPC settles",
		async (phase) => {
			const f = await fixture();
			if (phase === "admission") await f.configureSources();
			await f.stop();
			await f.adapter().reconcileStopped(f.binding, f.registry, signal());
			const original = await f.guard().status(f.permitId);
			if (phase === "admission") {
				await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow(
					"RUNNING_PERMIT_REQUIRED",
				);
				await f.guard().sweep();
				await f.controller().maintain(signal());
			}
			const method =
					phase === "resume"
						? "qorpera_prepare_runtime_office_outage_recovery"
						: "qorpera_prepare_runtime_office_outage_successor",
				originalCall = f.control.call.getMockImplementation()!,
				entered = deferred(),
				late = deferred();
			f.control.call.mockImplementation(async (name, args) => {
				const value = await originalCall(name, args);
				if (name === method) {
					entered.resolve();
					await late.promise;
				}
				return value;
			});
			const caller = new AbortController(),
				run = (checked: AbortSignal) =>
					phase === "resume"
						? f.worker().reconcile(f.intentId, original, checked)
						: f.admission().reconcile(f.intentId, original, f.serviceBootstrapPath, checked);
			let settled = false;
			const running = run(caller.signal).then(
				() => {
					settled = true;
					return null;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			try {
				await Promise.race([
					entered.promise,
					running.then((error) => {
						throw error ?? new Error("worker finished before blocked RPC");
					}),
				]);
				caller.abort();
				await expect(run(signal())).rejects.toThrow(
					phase === "resume" ? "OFFICE_OUTAGE_RESUME_PENDING" : "OFFICE_OUTAGE_ADMISSION_PENDING",
				);
				expect(settled).toBe(false);
			} finally {
				late.resolve();
			}
			expect(await running).toBeInstanceOf(Error);
			expect(settled).toBe(true);
			expect(f.client.submitOfficeOutageServiceStart).not.toHaveBeenCalled();
		},
	);
	it("admits a fresh funded boot and recovers a lost activation reply without repeating physical or guest starts", async () => {
		const f = await fixture();
		await f.configureSources();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		const original = await f.guard().status(f.permitId);
		await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow("RUNNING_PERMIT_REQUIRED");
		await f.guard().sweep();
		await f.controller().maintain(signal());
		const freshGuard = await f.controller().guardRecord(f.binding.allocationId, signal());
		await f.controller().maintain(signal());
		expect((await f.controller().guardRecord(f.binding.allocationId, signal()))?.stopAtUptimeMs).toBe(
			freshGuard?.stopAtUptimeMs,
		);
		expect(f.control.call.mock.calls.some(([method]) => method === "qorpera_renew_runtime_computer_permit")).toBe(
			false,
		);
		const measure = vi.fn(async () => {});
		f.loseActivation();
		await expect(
			f
				.admission(measure)
				.reconcile(f.intentId, original, f.serviceBootstrapPath, signal())
				.catch((error) => {
					if (measure.mock.calls.length === 0) throw error;
					throw new Error("expected lost activation");
				}),
		).rejects.toThrow("expected lost activation");
		expect(measure).toHaveBeenCalledOnce();
		await f.restart();
		const result = await f.admission(measure).reconcile(f.intentId, original, f.serviceBootstrapPath, signal());
		expect(result.state).toBe("active");
		expect(f.client.submitOfficeOutageConfiguration).toHaveBeenCalledOnce();
		expect(f.client.submitOfficeOutageServiceStart).toHaveBeenCalledOnce();
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		expect(f.client.submitInstanceOperation.mock.calls.map(([, request]) => request.action)).toEqual([
			"create",
			"start",
			"stop",
			"start",
		]);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("prepare_runtime_computer"))).toHaveLength(
			2,
		);
		expect((await f.guard().status(original.permit.permitId)).stopReceipt).toEqual(original.stopReceipt);
		if (result.state !== "active") throw new Error("admission did not finish");
		const marker = JSON.parse(
			await readFile(
				join(f.root, `outage-activation-completed-${f.binding.allocationId}-${result.activationId}.json`),
				"utf8",
			),
		);
		expect(marker.activation.state).toBe("active");
	});
	it("holds a recovery whose fresh paid computer stops before admission without creating another reservation", async () => {
		const f = await fixture();
		await f.configureSources();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		const original = await f.guard().status(f.permitId);
		await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow("RUNNING_PERMIT_REQUIRED");
		await f.guard().sweep();
		await f.controller().maintain(signal());
		expect((await f.termination().reconcile(f.intentId, original, signal())).state).toBe("awaiting_configuration");
		await f.stop();
		await f.controller().maintain(signal());
		await f.restart();
		await expect(f.admission().reconcile(f.intentId, original, f.serviceBootstrapPath, signal())).rejects.toThrow();
		expect(f.client.submitOfficeOutageConfiguration).not.toHaveBeenCalled();
		expect(f.client.submitOfficeOutageServiceStart).not.toHaveBeenCalled();
		expect(
			f.control.call.mock.calls.filter(([method]) => method === "qorpera_prepare_runtime_computer_permit"),
		).toHaveLength(2);
		expect(
			f.client.submitInstanceOperation.mock.calls.filter(([, request]) => request.action === "start"),
		).toHaveLength(2);
	});
	it("recovers a lost termination acknowledgement without reusing consumed base authority or repeating inspection", async () => {
		const f = await fixture();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		const original = await f.guard().status(f.permitId);
		await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow("RUNNING_PERMIT_REQUIRED");
		await f.guard().sweep();
		await f.controller().maintain(signal());
		f.loseAck();
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow("lost committed ACK");
		await f.restart();
		const result = await f.termination().reconcile(f.intentId, original, signal());
		expect(result.state).toBe("awaiting_configuration");
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toEqual(result);
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
	});
	it("closes and archives the expired permit, retains an external-stop bridge, then funds exactly one distinct boot across restart", async () => {
		const f = await fixture();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		const original = await f.guard().status(f.permitId);
		await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow("RUNNING_PERMIT_REQUIRED");
		await f.guard().sweep();
		await f.controller().maintain(signal());
		const result = await f.worker().reconcile(f.intentId, original, signal());
		expect(result.state).toBe("awaiting_termination");
		expect((await f.guard().status(f.permitId)).stopReceipt).toEqual(original.stopReceipt);
		expect((await f.guard().list()).map((record) => record.permit.permitId)).toEqual([result.request.startCommandId]);
		await f.restart();
		const replay = await f.worker().reconcile(f.intentId, original, signal());
		expect(replay).toEqual(result);
		expect(f.client.submitInstanceOperation.mock.calls.map(([, request]) => request.action)).toEqual([
			"create",
			"start",
			"stop",
			"start",
		]);
		expect((await f.journal.history()).events.map((event) => event.action)).toEqual([
			"create",
			"create",
			"create",
			"start",
			"start",
			"start",
		]);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish_runtime_computer"))).toHaveLength(
			1,
		);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("prepare_runtime_computer"))).toHaveLength(
			2,
		);
		await f.adapter().assertActive(f.binding, signal());
		await f.stop();
		await expect(f.controller().maintain(signal())).resolves.toBeUndefined();
		expect((await f.guard().status(result.request.startCommandId)).phase).toBe("stopped");
	});
	it.each(["physical", "host"])("refuses changed %s before a replacement start", async (fault) => {
		const f = await fixture();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		const original = await f.guard().status(f.permitId);
		await f.controller().maintain(signal());
		if (fault === "physical") Object.assign(f.vm.config, { "volatile.uuid": randomUUID() });
		else f.clock.hostBootId = randomUUID();
		await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow();
		expect(
			f.client.submitInstanceOperation.mock.calls.filter(([, request]) => request.action === "start"),
		).toHaveLength(1);
	});
});
