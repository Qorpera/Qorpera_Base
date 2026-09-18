import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyComputerStart,
	type CompanyComputerStartIntent,
	type CompanyComputerStartRpc,
} from "../src/index.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const intent: CompanyComputerStartIntent = {
		schema: "qorpera.office-start-intent/v1",
		intentId: id(5),
		companyComputerId: id(3),
		computerGeneration: 1,
		state: "requested",
	};
	const status = {
		scope,
		computerGeneration: 1,
		officeState: "provisioning",
		maintenance: null,
		intent: intent as CompanyComputerStartIntent | null,
	};
	const rpc = vi.fn<CompanyComputerStartRpc>(async (method) => ({
		data: structuredClone(
			method === "qorpera_runtime_office_start_status"
				? status
				: method === "qorpera_cancel_runtime_office_start"
					? { ...intent, state: "cancelled" }
					: intent,
		),
		error: null,
	}));
	return { scope, intent, status, rpc, client: new CloudCompanyComputerStart(scope, rpc) };
}
afterEach(() => vi.useRealTimers());
describe("shared member office startup API", () => {
	it("submits only authenticated scope/generation/request identity and accepts a coalesced intent", async () => {
		const f = fixture();
		await expect(f.client.request(1, id(9), signal())).resolves.toEqual(f.intent);
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith(
			"qorpera_request_runtime_office_start",
			{ p_scope: f.scope, p_computer_generation: 1, p_request_id: id(9) },
			expect.any(AbortSignal),
		);
	});
	it("recovers a committed request after response loss through current status without retrying the write", async () => {
		const f = fixture();
		f.rpc.mockRejectedValueOnce(new Error("lost response including secret SQL"));
		await expect(f.client.request(1, id(9), signal())).rejects.toThrow("OFFICE_START_UNCONFIRMED_REFRESH_STATUS");
		const recovered = await f.client.status(signal());
		expect(recovered.intent).toEqual(f.intent);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_request_runtime_office_start",
			"qorpera_runtime_office_start_status",
		]);
	});
	it("cancels only the exact observed intent and reads the durable cancellation separately", async () => {
		const f = fixture();
		await expect(f.client.cancel(f.intent, signal())).resolves.toEqual({ ...f.intent, state: "cancelled" });
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith(
			"qorpera_cancel_runtime_office_start",
			{ p_scope: f.scope, p_computer_generation: 1, p_intent_id: id(5) },
			expect.any(AbortSignal),
		);
		f.intent.state = "cancelled";
		await expect(f.client.status(signal())).resolves.toMatchObject({
			officeState: "provisioning",
			maintenance: null,
			intent: { state: "cancelled" },
		});
	});
	it("accepts an empty status for a new generation without reviving the old request", async () => {
		const f = fixture();
		f.status.computerGeneration = 2;
		f.status.intent = null;
		await expect(f.client.status(signal())).resolves.toEqual(f.status);
		expect(f.rpc).toHaveBeenCalledOnce();
	});
	it("copies supplied scope and returned state", async () => {
		const f = fixture();
		f.scope.companyId = id(90);
		await f.client.request(1, id(9), signal());
		expect(f.rpc.mock.calls[0][1].p_scope).toEqual({ ...f.scope, companyId: id(1) });
		f.scope.companyId = id(1);
		const observed = await f.client.status(signal());
		Object.assign(observed.scope, { companyId: id(90) });
		observed.intent!.state = "cancelled";
		await expect(f.client.status(signal())).resolves.toMatchObject({
			scope: { companyId: id(1) },
			intent: { state: "requested" },
		});
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
		"rejects invalid generation %s before RPC",
		async (generation) => {
			const f = fixture();
			await expect(f.client.request(generation, id(9), signal())).rejects.toThrow("INVALID_OFFICE_START_GENERATION");
			expect(f.rpc).not.toHaveBeenCalled();
		},
	);
	it.each(["companyComputerId", "computerGeneration", "intentId", "schema", "state", "providerUrl"])(
		"rejects changed intent data: %s",
		async (field) => {
			const f = fixture();
			f.rpc.mockResolvedValue({ data: { ...f.intent, [field]: "untrusted" }, error: null });
			await expect(f.client.request(1, id(9), signal())).rejects.toThrow("INVALID_OFFICE_START_RESPONSE");
		},
	);
	it("rejects cancelled request results and mismatched cancellation acknowledgements", async () => {
		const f = fixture();
		f.rpc.mockResolvedValueOnce({ data: { ...f.intent, state: "cancelled" }, error: null });
		await expect(f.client.request(1, id(9), signal())).rejects.toThrow("OFFICE_START_UNCONFIRMED_REFRESH_STATUS");
		f.rpc.mockResolvedValueOnce({ data: { ...f.intent, state: "cancelled", intentId: id(99) }, error: null });
		await expect(f.client.cancel(f.intent, signal())).rejects.toThrow("INVALID_OFFICE_START_RESPONSE");
	});
	it.each(["scope", "officeState", "computerGeneration", "providerPath"])(
		"rejects altered status: %s",
		async (field) => {
			const f = fixture();
			f.rpc.mockResolvedValueOnce({ data: { ...f.status, [field]: "untrusted" }, error: null });
			await expect(f.client.status(signal())).rejects.toThrow();
		},
	);
	it("rejects stale intent generation and extra scope metadata in status", async () => {
		const f = fixture();
		f.status.computerGeneration = 2;
		await expect(f.client.status(signal())).rejects.toThrow("INVALID_OFFICE_START_RESPONSE");
		f.status.computerGeneration = 1;
		Object.assign(f.scope, { command: "untrusted" });
		await expect(f.client.status(signal())).rejects.toThrow("INVALID_OFFICE_START_RESPONSE");
	});
	it("rejects another office's cancellation and malformed request identity before RPC", async () => {
		const f = fixture();
		await expect(f.client.cancel({ ...f.intent, companyComputerId: id(99) }, signal())).rejects.toThrow();
		await expect(f.client.request(1, "invalid", signal())).rejects.toThrow("INVALID_OFFICE_START_REQUEST");
		expect(f.rpc).not.toHaveBeenCalled();
	});
	it("does not expose authorization diagnostics or retry on denial", async () => {
		const f = fixture();
		f.rpc.mockResolvedValueOnce({ data: null, error: { message: "secret SQL" } });
		await expect(f.client.request(1, id(9), signal())).rejects.toThrow("OFFICE_START_UNCONFIRMED_REFRESH_STATUS");
		expect(f.rpc).toHaveBeenCalledOnce();
	});
	it("times out an unresponsive RPC without replay or lifetime cleanup calls", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.rpc.mockReturnValueOnce(new Promise(() => {}));
		const pending = expect(f.client.request(1, id(9), signal())).rejects.toThrow(
			"OFFICE_START_UNCONFIRMED_REFRESH_STATUS",
		);
		await vi.advanceTimersByTimeAsync(5001);
		await pending;
		expect(f.rpc).toHaveBeenCalledOnce();
	});
});
