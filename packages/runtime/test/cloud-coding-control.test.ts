import { afterEach, expect, it, vi } from "vitest";
import { HttpCloudCodingControl } from "../src/cloud-coding-control.ts";
import { CloudControlRpcEnded, cloudControlEnded, cloudControlRetryable } from "../src/cloud-control-errors.ts";
import { CLOUD_CODING_NATIVE_RPCS } from "../src/cloud-native-coding-runtime.ts";
import {
	CLOUD_RUN_ROW_READ_MS,
	CLOUD_RUN_ROW_WRITE_MS,
	CloudNativeToolRun,
} from "../src/cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "../src/cloud-runtime-observability.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

type Method = (typeof CLOUD_CODING_NATIVE_RPCS)[number];
const READS: Method[] = ["qorpera_authorize_coding_turn", "qorpera_read_coding_turn_context"];
const WRITES: Method[] = [
	"qorpera_begin_native_coding_execution",
	"qorpera_record_coding_context_view",
	"qorpera_submit_coding_turn",
];

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

/** A PostgREST error answer, as its error body is. */
function postgrest(status: number, code: string): Response {
	return new Response(JSON.stringify({ code, details: null, hint: null, message: "m" }), { status });
}
function control(fetch: typeof globalThis.fetch): HttpCloudCodingControl {
	return new HttpCloudCodingControl({ supabaseUrl: "https://db.example.test/", serviceRoleKey: "private", fetch });
}
/** What a call that must fail failed with. */
async function failure(call: Promise<unknown>): Promise<unknown> {
	return call.then(
		() => {
			throw new Error("The call answered");
		},
		(error: unknown) => error,
	);
}

it("covers every coding RPC as a read or a write", () => {
	expect([...READS, ...WRITES].sort()).toEqual([...CLOUD_CODING_NATIVE_RPCS].sort());
});

it("tells a read's lost or late answer apart, and whether its statement ended (R2, 31 Oct 2026)", async () => {
	const ended: [string, () => Response][] = [
		["a statement timeout", () => postgrest(500, "57014")],
		["PostgREST's pool wait", () => postgrest(504, "PGRST003")],
		["a serialization failure", () => postgrest(500, "40001")],
		["a lock timeout", () => postgrest(500, "55P03")],
	];
	const lost: [string, () => Response][] = [
		["PostgREST's connection error", () => postgrest(503, "PGRST001")],
		["a lost database connection", () => postgrest(503, "08006")],
		["a proxy's page", () => new Response("<html>Bad gateway</html>", { status: 502 })],
		["an empty 503", () => new Response(null, { status: 503 })],
		["an empty 408", () => new Response(null, { status: 408 })],
		["an empty 429", () => new Response(null, { status: 429 })],
	];
	for (const method of READS) {
		for (const [label, answer] of [...ended, ...lost]) {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
			const error = await failure(control(fetch).call(method, { p_binding: {} }, new AbortController().signal));
			const status = answer().status;
			expect(error, label).toBeInstanceOf(CloudRuntimeDiagnosticError);
			expect((error as CloudRuntimeDiagnosticError).category, label).toBe("transport_unavailable");
			expect((error as Error).message, label).toBe(`Coding control ${method} unconfirmed (${status})`);
			expect(cloudControlRetryable(error), label).toBe(true);
			expect(cloudControlEnded(error), label).toBe(ended.some(([name]) => name === label));
			expect(error instanceof CloudControlRpcEnded, label).toBe(ended.some(([name]) => name === label));
			// The control sends each call once: its caller decides whether to ask again.
			expect(fetch, label).toHaveBeenCalledTimes(1);
		}
	}
});

it("tells a read with no answer at all apart, and throws the caller's own cancellation as it came", async () => {
	for (const method of READS) {
		// A lost connection, and the control's own 30 s cut.
		for (const thrown of [
			new TypeError("fetch failed"),
			new DOMException("The operation was aborted due to timeout", "TimeoutError"),
		]) {
			const error = await failure(
				control(async () => Promise.reject(thrown)).call(method, { p_binding: {} }, new AbortController().signal),
			);
			expect(error).toBeInstanceOf(CloudRuntimeDiagnosticError);
			expect((error as CloudRuntimeDiagnosticError).category).toBe("transport_unavailable");
			expect((error as Error).message).toBe(`Coding control ${method} unconfirmed`);
			expect(cloudControlRetryable(error)).toBe(true);
			expect(cloudControlEnded(error)).toBe(false);
		}
		const caller = new AbortController();
		const reason = new Error("turn stopped");
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			caller.abort(reason);
			throw init?.signal?.reason;
		});
		await expect(control(fetch).call(method, { p_binding: {} }, caller.signal)).rejects.toBe(reason);
	}
});

it("keeps every refusal of a read a plain failure that is not asked again", async () => {
	const refused: [string, () => Response][] = [
		["lease or authority refused", () => postgrest(403, "42501")],
		["company execution paused", () => postgrest(500, "55000")],
		["invalid input", () => postgrest(400, "22023")],
		["raised by the function", () => postgrest(500, "P0001")],
		["an internal error", () => postgrest(500, "XX000")],
		["an empty 400", () => new Response(null, { status: 400 })],
		["an empty 404", () => new Response(null, { status: 404 })],
	];
	for (const method of READS) {
		for (const [label, answer] of refused) {
			const error = await failure(
				control(async () => answer()).call(method, { p_binding: {} }, new AbortController().signal),
			);
			expect(error, label).toBeInstanceOf(Error);
			expect(error, label).not.toBeInstanceOf(CloudRuntimeDiagnosticError);
			expect((error as Error).message, label).toBe(`Coding control ${method} unconfirmed (${answer().status})`);
			expect(cloudControlRetryable(error), label).toBe(false);
		}
	}
});

it("changes nothing for a write: every failure is a plain one, never one to ask again", async () => {
	for (const method of WRITES) {
		for (const answer of [
			() => postgrest(503, "PGRST001"),
			() => postgrest(500, "57014"),
			() => postgrest(504, "PGRST003"),
			() => new Response(null, { status: 503 }),
		]) {
			const error = await failure(control(async () => answer()).call(method, {}, new AbortController().signal));
			expect(error).not.toBeInstanceOf(CloudRuntimeDiagnosticError);
			expect((error as Error).message).toBe(`Coding control ${method} unconfirmed (${answer().status})`);
			expect(cloudControlRetryable(error)).toBe(false);
		}
		const lost = new TypeError("fetch failed");
		const error = await failure(
			control(async () => Promise.reject(lost)).call(method, {}, new AbortController().signal),
		);
		expect(error).toBe(lost);
		expect(cloudControlRetryable(error)).toBe(false);
	}
});

it("still answers a read and a write that succeed", async () => {
	for (const method of [...READS, ...WRITES]) {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		await expect(control(fetch).call(method, { p_binding: {} }, new AbortController().signal)).resolves.toEqual({
			ok: true,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe(`https://db.example.test/rest/v1/rpc/${method}`);
		expect(fetch.mock.calls[0][1]?.method).toBe("POST");
	}
});

async function admit(): Promise<{ run: CloudNativeToolRun; binding: unknown }> {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => structuredClone(authority) },
		new AbortController().signal,
	);
	runs.push(run);
	return { run, binding };
}

it("inside the run's retry, a write still throws its plain failure at once and is sent once", async () => {
	const { run, binding } = await admit();
	for (const method of WRITES) {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => postgrest(500, "57014"));
		const coding = control(fetch);
		const error = await failure(
			run.retry(
				(signal) => coding.call(method, { p_binding: binding }, signal),
				run.signal,
				CLOUD_RUN_ROW_WRITE_MS,
				CLOUD_RUN_ROW_WRITE_MS,
			),
		);
		expect(error).not.toBeInstanceOf(CloudRuntimeDiagnosticError);
		expect((error as Error).message).toBe(`Coding control ${method} unconfirmed (500)`);
		expect(fetch).toHaveBeenCalledTimes(1);
	}
	expect(run.signal.aborted).toBe(false);
});

it("inside the run's retry, a read whose statement ended is asked again after the first pause", async () => {
	const { run, binding } = await admit();
	for (const method of READS) {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(postgrest(500, "57014"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const coding = control(fetch);
		const begun = Date.now();
		await expect(
			run.retry(
				(signal) => coding.call(method, { p_binding: binding }, signal),
				run.signal,
				CLOUD_RUN_ROW_READ_MS,
				CLOUD_RUN_ROW_READ_MS,
			),
		).resolves.toMatchObject({ value: { ok: true } });
		expect(fetch).toHaveBeenCalledTimes(2);
		// The answer said the statement ended: no wait for the copy (R1), only the first pause.
		expect(Date.now() - begun).toBeLessThan(5_000);
	}
});
