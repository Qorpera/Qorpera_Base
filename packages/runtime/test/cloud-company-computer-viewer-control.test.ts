import { createHash, createHmac, randomBytes } from "node:crypto";
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
			: method === "qorpera_admit_runtime_office_viewer_input_window"
				? { state: "admitted", validForMs: 1000 }
				: structuredClone(grant),
	);
	const control = new CloudCompanyComputerViewerControl({ scope: computerScope(), control: { call } });
	const bytes = Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 65]);
	const input = { sequence: 1, bytes };
	const windows = () =>
		call.mock.calls.filter(([method]) => method === "qorpera_admit_runtime_office_viewer_input_window");
	return { grant, token, call, control, input, windows, signal: new AbortController().signal };
}
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof import("node:crypto")>();
	return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
afterEach(() => vi.restoreAllMocks());

/** Reference implementation of the ledger's window commitment, kept apart from
 * the adapter: HMAC over the chained per-packet HMACs, same per-connection key. */
function referenceWindow(key: Buffer, previous: string, first: number, packets: Uint8Array[]): string {
	const chain = createHmac("sha256", key).update(`window:${previous}:${first}:`);
	packets.forEach((bytes, index) => {
		chain.update(
			createHmac("sha256", key)
				.update(`${first + index}:`)
				.update(bytes)
				.digest(),
		);
	});
	return chain.update(`:${packets.length}`).digest("hex");
}
const pointerPacket = (x: number, mask = 0) => Uint8Array.from([5, mask, x >> 8, x & 255, 0, 7]);

describe("durable viewer authority adapter", () => {
	it.each(["control", "shared"] as const)(
		"redeems exact %s tickets and records input locally under one confirmed window",
		async (mode) => {
			const f = fixture(mode);
			const grant = await f.control.redeem(f.token, f.signal);
			expect(f.call.mock.calls[0][1]).toEqual({
				p_scope: computerScope(),
				p_capability_sha256: createHash("sha256").update(f.token).digest("hex"),
			});
			expect(() => f.control.recordInput(grant, f.input)).toThrow("VIEWER_INPUT_WINDOW_CLOSED");
			expect(await f.control.admitInputWindow(grant, f.signal)).toEqual({ validForMs: 1000 });
			expect(f.windows()[0][1]).toEqual({
				p_grant: grant,
				p_first_sequence: 1,
				p_count: 0,
				p_window_commitment: null,
			});
			// The rejected packet above consumed nothing.
			expect(f.control.recordInput(grant, f.input)).toBe(1);
			for (let sequence = 2; sequence <= 500; sequence++)
				expect(f.control.recordInput(grant, { sequence, bytes: pointerPacket(sequence) })).toBe(sequence);
			expect(f.windows()).toHaveLength(1);
			expect(f.input.bytes[7]).toBe(65);
			expect(() => f.control.recordInput(grant, f.input)).toThrow("INVALID_VIEWER_INPUT");
			expect(() => f.control.recordInput(grant, { sequence: 502, bytes: pointerPacket(1) })).toThrow(
				"INVALID_VIEWER_INPUT",
			);
		},
	);

	it("chains window commitments over contiguous sequences, verified against a reference, without raw input", async () => {
		const key = Buffer.alloc(32, 7);
		vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.from(key));
		const f = fixture("shared");
		const grant = await f.control.redeem(f.token, f.signal);
		await f.control.admitInputWindow(grant, f.signal);
		const first = [f.input.bytes, pointerPacket(10), pointerPacket(11, 1)];
		first.forEach((bytes, index) => {
			f.control.recordInput(grant, { sequence: index + 1, bytes });
		});
		await f.control.admitInputWindow(grant, f.signal);
		const second = [pointerPacket(12, 1), pointerPacket(12)];
		second.forEach((bytes, index) => {
			f.control.recordInput(grant, { sequence: index + 4, bytes });
		});
		await f.control.admitInputWindow(grant, f.signal);
		await f.control.admitInputWindow(grant, f.signal);
		const reports = f.windows().map(([, args]) => args);
		const firstCommitment = referenceWindow(key, "", 1, first);
		expect(reports).toEqual([
			{ p_grant: grant, p_first_sequence: 1, p_count: 0, p_window_commitment: null },
			{ p_grant: grant, p_first_sequence: 1, p_count: 3, p_window_commitment: firstCommitment },
			{
				p_grant: grant,
				p_first_sequence: 4,
				p_count: 2,
				p_window_commitment: referenceWindow(key, firstCommitment, 4, second),
			},
			{ p_grant: grant, p_first_sequence: 6, p_count: 0, p_window_commitment: null },
		]);
		// Individual key codes are enumerable: neither the bytes nor an unkeyed digest leave memory.
		const serialized = JSON.stringify(reports);
		expect(serialized).not.toContain(Buffer.from(f.input.bytes).toString("hex"));
		expect(serialized).not.toContain(createHash("sha256").update(f.input.bytes).digest("hex"));
	});

	it("packets recorded while a renewal is in flight belong to the next window", async () => {
		const f = fixture("shared");
		const grant = await f.control.redeem(f.token, f.signal);
		await f.control.admitInputWindow(grant, f.signal);
		f.control.recordInput(grant, f.input);
		const wait = computerDeferred<unknown>();
		f.call.mockImplementationOnce(() => wait.promise);
		const renewal = f.control.admitInputWindow(grant, f.signal);
		await vi.waitFor(() => expect(f.windows()).toHaveLength(2));
		expect(f.control.recordInput(grant, { sequence: 2, bytes: pointerPacket(3) })).toBe(1);
		await expect(f.control.admitInputWindow(grant, f.signal)).rejects.toThrow("INVALID_VIEWER_INPUT");
		wait.resolve({ state: "admitted", validForMs: 1000 });
		await renewal;
		await f.control.admitInputWindow(grant, f.signal);
		expect(f.windows().map(([, args]) => [args.p_first_sequence, args.p_count])).toEqual([
			[1, 0],
			[1, 1],
			[2, 1],
		]);
	});

	it.each([
		["a refusal", { state: "refused" }, "VIEWER_INPUT_REFUSED"],
		["a lost response", new Error("response lost"), "response lost"],
		["a longer validity than the bound", { state: "admitted", validForMs: 1001 }, "VIEWER_INPUT_UNCONFIRMED"],
		[
			"a per-packet reply",
			{ state: "admitted", inputId: computerId(22), validForMs: 1000 },
			"VIEWER_INPUT_UNCONFIRMED",
		],
	] as const)("stops input for good after %s and never retries the window", async (_name, reply, message) => {
		const f = fixture();
		const grant = await f.control.redeem(f.token, f.signal);
		await f.control.admitInputWindow(grant, f.signal);
		f.control.recordInput(grant, f.input);
		if (reply instanceof Error) f.call.mockRejectedValueOnce(reply);
		else f.call.mockResolvedValueOnce(reply);
		await expect(f.control.admitInputWindow(grant, f.signal)).rejects.toThrow(message);
		expect(() => f.control.recordInput(grant, { sequence: 2, bytes: pointerPacket(1) })).toThrow(
			"VIEWER_INPUT_WINDOW_CLOSED",
		);
		await expect(f.control.admitInputWindow(grant, f.signal)).rejects.toThrow("INVALID_VIEWER_INPUT");
		expect(f.windows()).toHaveLength(2);
	});

	it("closes the window when its validity lapses and rejects a late confirmation", async () => {
		const f = fixture();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		await f.control.redeem(f.token, f.signal);
		await expect(f.control.check({ ...f.grant, privacyVersion: 1 }, f.signal)).rejects.toThrow();
		await f.control.admitInputWindow(f.grant, f.signal);
		now = 999;
		expect(f.control.recordInput(f.grant, f.input)).toBe(1);
		now = 1000;
		expect(() => f.control.recordInput(f.grant, { sequence: 2, bytes: pointerPacket(1) })).toThrow(
			"VIEWER_INPUT_WINDOW_CLOSED",
		);
		const wait = computerDeferred<unknown>();
		f.call.mockImplementationOnce(() => wait.promise);
		const result = f.control.admitInputWindow(f.grant, f.signal);
		await vi.waitFor(() => expect(f.windows()).toHaveLength(2));
		now = 2001;
		wait.resolve({ state: "admitted", validForMs: 1000 });
		await expect(result).rejects.toThrow("VIEWER_INPUT_UNCONFIRMED");
		expect(() => f.control.recordInput(f.grant, { sequence: 2, bytes: pointerPacket(1) })).toThrow();
	});

	it("rejects watch input, malformed packets and clipboard frames without a registry call", async () => {
		const watcher = fixture("watch");
		await watcher.control.redeem(watcher.token, watcher.signal);
		await expect(watcher.control.admitInputWindow(watcher.grant, watcher.signal)).rejects.toThrow();
		expect(() => watcher.control.recordInput(watcher.grant, watcher.input)).toThrow("INVALID_VIEWER_INPUT");
		expect(watcher.windows()).toHaveLength(0);
		const f = fixture();
		await f.control.redeem(f.token, f.signal);
		await f.control.admitInputWindow(f.grant, f.signal);
		for (const bytes of [
			Uint8Array.from([6, 0, 0, 0, 0, 0, 0, 0]),
			Uint8Array.from([4, 2, 0, 0, 0, 0, 0, 65]),
			Uint8Array.from([5, 0, 7, 128, 0, 0]),
			Uint8Array.from([255, 0, 0, 1, 0, 0, 0, 65, 0, 0, 0, 30]),
		])
			expect(() => f.control.recordInput(f.grant, { sequence: 1, bytes })).toThrow("INVALID_VIEWER_INPUT");
		expect(f.control.recordInput(f.grant, f.input)).toBe(1);
	});

	it("reports the last window at release, including one whose confirmation was lost", async () => {
		const f = fixture("shared");
		const grant = await f.control.redeem(f.token, f.signal);
		await f.control.admitInputWindow(grant, f.signal);
		f.control.recordInput(grant, f.input);
		f.call.mockRejectedValueOnce(new Error("response lost"));
		await expect(f.control.admitInputWindow(grant, f.signal)).rejects.toThrow();
		await f.control.release(grant, f.signal);
		expect(
			f.call.mock.calls.slice(-2).map(([method, args]) => [method, args.p_first_sequence, args.p_count]),
		).toEqual([
			["qorpera_admit_runtime_office_viewer_input_window", 1, 1],
			["qorpera_release_runtime_office_viewer", undefined, undefined],
		]);
		const open = fixture("shared");
		await open.control.redeem(open.token, open.signal);
		await open.control.admitInputWindow(open.grant, open.signal);
		open.control.recordInput(open.grant, open.input);
		open.call.mockImplementation(async (method) => {
			if (method === "qorpera_release_runtime_office_viewer") return { state: "released" };
			throw new Error("registry unavailable");
		});
		await open.control.release(open.grant, open.signal);
		expect(open.windows().at(-1)?.[1]).toMatchObject({ p_first_sequence: 1, p_count: 1 });
		expect(open.call.mock.calls.at(-1)?.[0]).toBe("qorpera_release_runtime_office_viewer");
	});

	it("keeps expired or released sessions closed while exact cleanup remains possible", async () => {
		const f = fixture();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		await f.control.redeem(f.token, f.signal);
		now = 30001;
		await expect(f.control.check(f.grant, f.signal)).rejects.toThrow("VIEWER_EXPIRED");
		await expect(f.control.admitInputWindow(f.grant, f.signal)).rejects.toThrow("VIEWER_EXPIRED");
		await f.control.release(f.grant, f.signal);
		await expect(f.control.check(f.grant, f.signal)).rejects.toThrow("VIEWER_EXPIRED");
		expect(f.call.mock.calls.at(-1)?.[0]).toBe("qorpera_release_runtime_office_viewer");
	});
});
