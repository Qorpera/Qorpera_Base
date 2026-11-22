import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { companyComputerRequest } from "../src/cloud-company-computer-contract.ts";
import { CloudRequestTimeoutError, withCloudDeadline } from "../src/cloud-request.ts";

describe("cloud request abort scopes", () => {
	it("detaches parent abort listeners after withCloudDeadline settles and forwards aborts", async () => {
		const parent = new AbortController();
		for (let i = 0; i < 10; i++) {
			const value = await withCloudDeadline(async () => i, 5_000, parent.signal);
			expect(value).toBe(i);
		}
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);

		await expect(withCloudDeadline(() => new Promise(() => undefined), 25, parent.signal)).rejects.toBeInstanceOf(
			CloudRequestTimeoutError,
		);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);

		const reason = new Error("PARENT_STOPPED");
		const abortable = new AbortController();
		const pending = withCloudDeadline(
			(signal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			5_000,
			abortable.signal,
		);
		abortable.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(getEventListeners(abortable.signal, "abort")).toHaveLength(0);
	});

	it("detaches parent abort listeners after companyComputerRequest settles and rejects pre-aborted signals", async () => {
		const parent = new AbortController();
		for (let i = 0; i < 10; i++) {
			const value = await companyComputerRequest(async () => i, parent.signal, 5_000);
			expect(value).toBe(i);
		}
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);

		await expect(companyComputerRequest(() => new Promise(() => undefined), parent.signal, 25)).rejects.toThrow(
			"COMPUTER_REQUEST_STOPPED",
		);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);

		const aborted = new AbortController();
		aborted.abort(new Error("ALREADY_STOPPED"));
		await expect(companyComputerRequest(async () => "ok", aborted.signal, 5_000)).rejects.toThrow(
			"COMPUTER_REQUEST_STOPPED",
		);
		expect(getEventListeners(aborted.signal, "abort")).toHaveLength(0);
	});
});
