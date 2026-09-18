import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyComputerSignIn,
	type CloudCompanyComputerSignInRpc,
} from "../src/cloud-company-computer-sign-in.ts";

const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const challenge = {
		scope,
		computerGeneration: 1,
		challengeId: id(5),
		version: 1,
		state: "entering" as const,
		memberId: id(6),
		profileId: id(7),
		profileVersion: 2,
		screenId: id(8),
		drains: [
			{
				state: "draining" as const,
				drainId: id(9),
				epoch: 2,
				binding: {
					...scope,
					computerGeneration: 1,
					screenId: id(8),
					screenOrdinal: 1,
					screenGeneration: 2,
					staffAgentId: id(10),
				},
			},
		],
	};
	const rpc = vi.fn<CloudCompanyComputerSignInRpc>(async () => ({ data: challenge, error: null }));
	const client = new CloudCompanyComputerSignIn({ scope, memberId: id(6), rpc });
	return { scope, challenge, rpc, client, signal: new AbortController().signal };
}
afterEach(() => vi.useRealTimers());
describe("shared client office sign-in", () => {
	it("submits exact owner intent without admitting private input", async () => {
		const f = fixture();
		expect(await f.client.request(id(7), id(8), 0, true, f.signal)).toEqual(f.challenge);
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith(
			"qorpera_request_runtime_office_privacy",
			{ p_scope: f.scope, p_profile_id: id(7), p_screen_id: id(8), p_expected_version: 0, p_private: true },
			expect.any(AbortSignal),
		);
	});
	it("recovers a lost response by reading status without retrying the transition", async () => {
		const f = fixture();
		f.rpc.mockRejectedValueOnce(new Error("lost response with sensitive diagnostics"));
		await expect(f.client.request(id(7), id(8), 0, true, f.signal)).rejects.toThrow(
			"OFFICE_SIGN_IN_UNCONFIRMED_REFRESH_STATUS",
		);
		f.rpc.mockResolvedValue({
			data: { scope: f.scope, computerGeneration: 1, state: "entering", version: 1, challenge: f.challenge },
			error: null,
		});
		expect((await f.client.status(f.signal)).challenge).toEqual(f.challenge);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_request_runtime_office_privacy",
			"qorpera_runtime_office_privacy_status",
		]);
	});
	it("rejects another owner, stale generation/version, substituted profile and additional secret fields", async () => {
		const f = fixture();
		for (const change of [{ memberId: id(99) }, { version: 2 }, { profileId: id(99) }, { password: "untrusted" }]) {
			f.rpc.mockResolvedValue({ data: { ...f.challenge, ...change }, error: null });
			await expect(f.client.request(id(7), id(8), 0, true, f.signal)).rejects.toThrow();
		}
		f.rpc.mockResolvedValue({
			data: { scope: f.scope, computerGeneration: 2, state: "private", version: 1, challenge: f.challenge },
			error: null,
		});
		await expect(f.client.status(f.signal)).rejects.toThrow();
	});
	it("keeps another member's status challenge absent and never treats it as a private grant", async () => {
		const f = fixture();
		f.rpc.mockResolvedValue({
			data: { scope: f.scope, computerGeneration: 1, state: "private", version: 1, challenge: null },
			error: null,
		});
		expect(await f.client.status(f.signal)).toMatchObject({ state: "private", challenge: null });
		await expect(f.client.checkPrivateAccess({ ...f.challenge, memberId: id(99) }, f.signal)).rejects.toThrow(
			"INVALID_PRIVATE_SIGN_IN_OWNER",
		);
		expect(f.rpc).toHaveBeenCalledTimes(1);
	});
	it("rechecks private access every time and fails closed on revocation", async () => {
		const f = fixture();
		f.rpc.mockResolvedValueOnce({ data: { state: "authorized", version: 1, validForMs: 5000 }, error: null });
		await f.client.checkPrivateAccess(f.challenge, f.signal);
		f.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
		await expect(f.client.checkPrivateAccess(f.challenge, f.signal)).rejects.toThrow(
			"OFFICE_SIGN_IN_UNCONFIRMED_REFRESH_STATUS",
		);
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});
	it("bounds an unresponsive request without retry or local resume", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.rpc.mockImplementation(() => new Promise(() => undefined));
		const pending = f.client.request(id(7), id(8), 0, true, f.signal);
		const rejected = expect(pending).rejects.toThrow("OFFICE_SIGN_IN_UNCONFIRMED_REFRESH_STATUS");
		await vi.advanceTimersByTimeAsync(5001);
		await rejected;
		expect(f.rpc).toHaveBeenCalledTimes(1);
		expect(f.rpc.mock.calls[0][2].aborted).toBe(true);
	});
});
