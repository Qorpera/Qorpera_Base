import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officeOutageWorkerFixture } from "./fixtures/office-outage-worker.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
	const f = await officeOutageWorkerFixture(roots);
	await f.stop();
	await f.adapter().reconcileStopped(f.binding, f.registry, signal());
	const original = await f.guard().status(f.permitId);
	await expect(f.worker().reconcile(f.intentId, original, signal())).rejects.toThrow("RUNNING_PERMIT_REQUIRED");
	await f.guard().sweep();
	await f.sampleUsage();
	await f.controller().maintain(signal());
	return { f, original };
}

describe("outage termination inspection replay", () => {
	it.each(["pending", "readback crash"] as const)(
		"recovers a %s inspection after provider restart without another guest command",
		async (fault) => {
			const { f, original } = await fixture();
			if (fault === "pending") {
				f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
				await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
					state: "pending",
				});
			} else {
				const read = f.client.readInstanceFile.getMockImplementation()!;
				let crash = true;
				f.client.readInstanceFile.mockImplementation(async (project, name, path) => {
					if (crash && path.includes("/outage-termination-inspection-")) {
						crash = false;
						throw new Error("provider crashed before retaining inspection");
					}
					return read(project, name, path);
				});
				await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow(
					"provider crashed before retaining inspection",
				);
			}
			await f.restart();
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
				state: "awaiting_configuration",
			});
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
			expect(f.client.pushOfficeOutageTerminationRequest).toHaveBeenCalledOnce();
			expect((await readdir(f.root)).filter((name) => name.startsWith("outage-inspection-"))).toHaveLength(1);
		},
	);
	it.each(["pending", "unknown"] as const)(
		"holds an existing %s operation without spending another inspection attempt",
		async (state) => {
			const { f, original } = await fixture();
			f.client.inspectOfficeOutageTermination.mockResolvedValue("pending");
			await f.termination().reconcile(f.intentId, original, signal());
			if (state === "unknown")
				f.client.inspectOfficeOutageTermination.mockRejectedValue(new Error("lost LXD operation"));
			else f.client.inspectOfficeOutageTermination.mockResolvedValue(state);
			await f.restart();
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({ state });
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
			expect(
				f.control.call.mock.calls.some(([method]) => method === "qorpera_ack_runtime_office_outage_termination"),
			).toBe(false);
		},
	);
	it.each([false, true])(
		"replaces a confirmed failed inspection and replays its later ACK (lost reply: %s)",
		async (lostAck) => {
			const { f, original } = await fixture();
			f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
			await f.termination().reconcile(f.intentId, original, signal());
			const firstOperation = f.client.inspectOfficeOutageTermination.mock.calls[0]![0];
			f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("failed");
			await f.restart();
			if (lostAck) {
				f.loseAck();
				await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
				await f.restart();
			}
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
				state: "awaiting_configuration",
			});
			expect(f.client.inspectOfficeOutageTermination.mock.calls[1]![0]).toEqual(firstOperation);
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledTimes(2);
			expect(f.client.submitOfficeOutageTermination.mock.calls[0]![2].commandId).not.toBe(
				f.client.submitOfficeOutageTermination.mock.calls[1]![2].commandId,
			);
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
				state: "awaiting_configuration",
			});
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledTimes(2);
		},
	);
	it("holds a dispatch with lost acceptance without repeating the guest command", async () => {
		const { f, original } = await fixture();
		f.client.submitOfficeOutageTermination.mockRejectedValueOnce(new Error("lost LXD acceptance"));
		await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
			state: "unknown",
		});
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
			state: "unknown",
		});
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		expect(
			f.control.call.mock.calls.some(([method]) => method === "qorpera_ack_runtime_office_outage_termination"),
		).toBe(false);
	});
	it("refuses a fresh challenge after terminal failure when current authority is denied", async () => {
		const { f, original } = await fixture();
		f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
		await f.termination().reconcile(f.intentId, original, signal());
		f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("failed");
		const call = f.control.call.getMockImplementation()!;
		let checks = 0;
		f.control.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_check_runtime_office_outage_recovery" && ++checks === 2)
				throw new Error("authority revoked after observing failure");
			return call(method, args);
		});
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
		expect(checks).toBe(2);
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		expect((await readdir(f.root)).filter((name) => name.startsWith("outage-inspection-"))).toHaveLength(1);
	});
	it.each([false, true])(
		"does not revive an expired challenge while replaying its later ACK (lost reply: %s)",
		async (lostAck) => {
			const { f, original } = await fixture();
			f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
			await f.termination().reconcile(f.intentId, original, signal());
			const first = JSON.parse(f.client.pushOfficeOutageTerminationRequest.mock.calls[0]![3].toString());
			const expired = first.challenge.request.inspectionId;
			const call = f.control.call.getMockImplementation()!;
			let rejected = false;
			f.control.call.mockImplementation(async (method, args) => {
				if (method === "qorpera_ack_runtime_office_outage_termination") {
					const request = args.p_request as { inspection: { inspectionId: string } };
					if (request.inspection.inspectionId === expired) {
						rejected = true;
						throw new Error("original SQL challenge expired");
					}
				}
				return call(method, args);
			});
			await f.restart();
			if (lostAck) {
				f.loseAck();
				await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
				await f.restart();
			}
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
				state: "awaiting_configuration",
			});
			expect(rejected).toBe(true);
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledTimes(2);
			const fresh = JSON.parse(f.client.pushOfficeOutageTerminationRequest.mock.calls[1]![3].toString());
			expect(fresh.challenge.request.inspectionId).not.toBe(expired);
			await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
				state: "awaiting_configuration",
			});
			expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledTimes(2);
		},
	);
	it("refuses replay when the retained request packet is missing", async () => {
		const { f, original } = await fixture();
		f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
		await f.termination().reconcile(f.intentId, original, signal());
		const attempt = (await readdir(f.root)).find((name) => name.startsWith("outage-inspection-"))!;
		await rm(join(f.root, attempt, "packet.json"));
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
	});
	it("refuses a retained inspection whose exact command journal was lost", async () => {
		const { f, original } = await fixture();
		f.loseAck();
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow("lost committed ACK");
		const attempt = (await readdir(f.root)).find((name) => name.startsWith("outage-inspection-"))!;
		const journal = (await readdir(join(f.root, attempt))).find((name) => name.startsWith("outage-termination-"))!;
		await rm(join(f.root, attempt, journal), { recursive: true });
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
	});
	it.each([
		{ fault: "push", denied: false },
		{ fault: "readback", denied: false },
		{ fault: "push", denied: true },
		{ fault: "readback", denied: true },
	] as const)(
		"replaces a never-dispatched attempt after $fault failure only with fresh authority (denied: $denied)",
		async ({ fault, denied }) => {
			const { f, original } = await fixture();
			const staging =
				fault === "push"
					? f.client.pushOfficeOutageTerminationRequest
					: f.client.readOfficeOutageTerminationRequest;
			staging.mockRejectedValueOnce(new Error("crash before dispatch"));
			await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow(
				"crash before dispatch",
			);
			const attempt = (await readdir(f.root)).find((name) => name.startsWith("outage-inspection-"))!;
			const attemptRoot = join(f.root, attempt);
			const packetBytes = await readFile(join(attemptRoot, "packet.json"), "utf8");
			const packet = JSON.parse(packetBytes);
			const journal = (await readdir(attemptRoot)).find((name) => name.startsWith("outage-termination-"))!;
			expect(await readdir(join(attemptRoot, journal))).toEqual(["authority.json"]);
			expect(f.client.submitOfficeOutageTermination).not.toHaveBeenCalled();
			const call = f.control.call.getMockImplementation()!;
			let checks = 0;
			if (denied)
				f.control.call.mockImplementation(async (method, args) => {
					if (method === "qorpera_check_runtime_office_outage_recovery") {
						checks++;
						throw new Error("fresh recovery authority denied");
					}
					return call(method, args);
				});
			await f.restart();
			if (denied) {
				await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow();
				expect(checks).toBe(1);
				expect(f.client.submitOfficeOutageTermination).not.toHaveBeenCalled();
				expect(f.client.inspectOfficeOutageTermination).not.toHaveBeenCalled();
			} else {
				await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
					state: "awaiting_configuration",
				});
				await f.restart();
				await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
					state: "awaiting_configuration",
				});
				expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
				const submitted = f.client.submitOfficeOutageTermination.mock.calls[0]![2];
				expect(submitted.commandId).not.toBe(packet.command.commandId);
				expect(submitted.requestSha256).not.toBe(packet.command.requestSha256);
				const fresh = JSON.parse(f.client.pushOfficeOutageTerminationRequest.mock.calls[1]![3].toString());
				expect(fresh.challenge.request.inspectionId).not.toBe(packet.request.challenge.request.inspectionId);
			}
			expect(f.client.pushOfficeOutageTerminationRequest).toHaveBeenCalledTimes(denied ? 1 : 2);
			expect(
				f.control.call.mock.calls.filter(
					([method]) => method === "qorpera_prepare_runtime_office_outage_termination",
				),
			).toHaveLength(denied ? 1 : 2);
			expect((await readdir(f.root)).filter((name) => name.startsWith("outage-inspection-"))).toHaveLength(
				denied ? 1 : 2,
			);
			expect(await readdir(join(attemptRoot, journal))).toEqual(["authority.json"]);
			expect(await readFile(join(attemptRoot, "packet.json"), "utf8")).toBe(packetBytes);
		},
	);
	it("refuses completed-operation readback after fresh authority is revoked", async () => {
		const { f, original } = await fixture();
		f.client.inspectOfficeOutageTermination.mockResolvedValueOnce("pending");
		await f.termination().reconcile(f.intentId, original, signal());
		const call = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_check_runtime_office_outage_recovery") throw new Error("recovery revoked");
			return call(method, args);
		});
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
			state: "unknown",
		});
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		expect(f.client.inspectOfficeOutageTermination).toHaveBeenCalledOnce();
		expect(
			f.control.call.mock.calls.some(([method]) => method === "qorpera_ack_runtime_office_outage_termination"),
		).toBe(false);
	});
	it("recovers a seed-only crash with a distinct fresh challenge", async () => {
		const { f, original } = await fixture();
		const call = f.control.call.getMockImplementation()!;
		let crash = true;
		f.control.call.mockImplementation(async (method, args) => {
			if (crash && method === "qorpera_prepare_runtime_office_outage_termination") {
				crash = false;
				throw new Error("crash before packet publication");
			}
			return call(method, args);
		});
		await expect(f.termination().reconcile(f.intentId, original, signal())).rejects.toThrow(
			"crash before packet publication",
		);
		await f.restart();
		await expect(f.termination().reconcile(f.intentId, original, signal())).resolves.toMatchObject({
			state: "awaiting_configuration",
		});
		expect(f.client.submitOfficeOutageTermination).toHaveBeenCalledOnce();
		expect((await readdir(f.root)).filter((name) => name.startsWith("outage-inspection-"))).toHaveLength(2);
	});
});
