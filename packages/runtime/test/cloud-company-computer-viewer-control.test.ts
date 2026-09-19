import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import {
	CloudCompanyComputerViewerControl,
	type CompanyComputerViewerRegistry,
} from "@qorpera/runtime/cloud-company-computer-viewer-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerScope,
} from "./fixtures/company-computer.ts";

function fixture(mode: CompanyComputerViewerGrant["mode"] = "control") {
	const grant: CompanyComputerViewerGrant = {
		binding: computerBinding(),
		viewerSessionId: computerId(21),
		memberId: computerId(8),
		mode,
		privacyVersion: 0,
		screenEpoch: 1,
		validForMs: 30000,
		...(mode === "control"
			? {
					lease: {
						...computerLease(),
						driver: { kind: "member" as const, memberId: computerId(8), sessionId: computerId(21) },
					},
				}
			: {}),
	};
	const token = "a".repeat(43);
	const call = vi.fn<CompanyComputerViewerRegistry["call"]>(async (method) =>
		method === "qorpera_release_runtime_office_viewer"
			? { state: "released" }
			: method === "qorpera_admit_runtime_office_viewer_input"
				? { state: "admitted", inputId: computerId(22), validForMs: 5000 }
				: structuredClone(grant),
	);
	const control = new CloudCompanyComputerViewerControl({ scope: computerScope(), control: { call } });
	const bytes = Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 65]);
	const input = { sequence: 1, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
	return { grant, token, call, control, input, signal: new AbortController().signal };
}
afterEach(() => vi.restoreAllMocks());
describe("durable viewer authority adapter", () => {
	it.each(["control", "shared"] as const)(
		"redeems exact %s tickets and admits keyed input before a single forward",
		async (mode) => {
			const f = fixture(mode);
			const grant = await f.control.redeem(f.token, f.signal);
			expect(f.call.mock.calls[0][1]).toEqual({
				p_scope: computerScope(),
				p_capability_sha256: createHash("sha256").update(f.token).digest("hex"),
			});
			const forward = vi.fn();
			await f.control.forwardInput(grant, f.input, forward, f.signal);
			expect(forward).toHaveBeenCalledOnce();
			const args = f.call.mock.calls[1][1];
			expect(args).toMatchObject({ p_sequence: 1, p_grant: grant });
			expect(args.p_input_commitment).toMatch(/^[0-9a-f]{64}$/);
			expect(args.p_input_commitment).not.toBe(f.input.sha256);
			expect(Object.keys(args).sort()).toEqual(["p_grant", "p_input_commitment", "p_sequence"]);
			expect(f.input.bytes[7]).toBe(65);
			await expect(f.control.forwardInput(grant, f.input, forward, f.signal)).rejects.toThrow(
				"INVALID_VIEWER_INPUT",
			);
			expect(forward).toHaveBeenCalledOnce();
		},
	);
	it("does not forward or retry on a lost input admission response", async () => {
		const f = fixture();
		const grant = await f.control.redeem(f.token, f.signal);
		f.call.mockRejectedValueOnce(new Error("response lost"));
		const forward = vi.fn();
		await expect(f.control.forwardInput(grant, f.input, forward, f.signal)).rejects.toThrow();
		await expect(f.control.forwardInput(grant, f.input, forward, f.signal)).rejects.toThrow();
		expect(forward).not.toHaveBeenCalled();
		expect(f.call).toHaveBeenCalledTimes(2);
	});
	it("rejects watch input, substituted bytes and clipboard frames", async () => {
		const watcher = fixture("watch");
		await watcher.control.redeem(watcher.token, watcher.signal);
		await expect(
			watcher.control.forwardInput(watcher.grant, watcher.input, () => undefined, watcher.signal),
		).rejects.toThrow();
		const f = fixture();
		await f.control.redeem(f.token, f.signal);
		await expect(
			f.control.forwardInput(f.grant, { ...f.input, sha256: "a".repeat(64) }, () => undefined, f.signal),
		).rejects.toThrow();
		const bytes = Uint8Array.from([6, 0, 0, 0, 0, 0, 0, 0]);
		await expect(
			f.control.forwardInput(
				f.grant,
				{ sequence: 1, bytes, sha256: createHash("sha256").update(bytes).digest("hex") },
				() => undefined,
				f.signal,
			),
		).rejects.toThrow();
		expect(f.call).toHaveBeenCalledTimes(1);
	});
	it("rejects stale privacy/driver identity and late input admission", async () => {
		const f = fixture();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		await f.control.redeem(f.token, f.signal);
		await expect(f.control.check({ ...f.grant, privacyVersion: 1 }, f.signal)).rejects.toThrow();
		const wait = computerDeferred<unknown>();
		f.call.mockImplementationOnce(() => wait.promise);
		const forward = vi.fn();
		const result = f.control.forwardInput(f.grant, f.input, forward, f.signal);
		await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
		now = 5001;
		wait.resolve({ state: "admitted", inputId: computerId(22), validForMs: 5000 });
		await expect(result).rejects.toThrow("VIEWER_INPUT_UNCONFIRMED");
		expect(forward).not.toHaveBeenCalled();
	});
	it("keeps expired or released sessions closed while exact cleanup remains possible", async () => {
		const f = fixture();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		await f.control.redeem(f.token, f.signal);
		now = 30001;
		await expect(f.control.check(f.grant, f.signal)).rejects.toThrow("VIEWER_EXPIRED");
		await f.control.release(f.grant, f.signal);
		await expect(f.control.check(f.grant, f.signal)).rejects.toThrow("VIEWER_EXPIRED");
		expect(f.call.mock.calls.at(-1)?.[0]).toBe("qorpera_release_runtime_office_viewer");
	});
});
