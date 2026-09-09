import { parseCompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { CompanyComputerPrivacySupervisor } from "@qorpera/runtime/cloud-company-computer-privacy";
import { describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	const challenge = {
		scope: computerScope(),
		computerGeneration: 1,
		challengeId: computerId(40),
		version: 1,
		state: "entering" as const,
		memberId: computerId(41),
		profileId: computerId(42),
		profileVersion: 2,
		screenId: computerBinding().screenId,
		drains: [
			{ state: "draining" as const, drainId: computerId(43), epoch: 2, binding: computerBinding() },
			{
				state: "draining" as const,
				drainId: computerId(44),
				epoch: 3,
				binding: { ...computerBinding(), screenId: computerId(45), screenOrdinal: 2, staffAgentId: computerId(46) },
			},
		],
	};
	const order: string[] = [];
	const fence = vi.fn(async () => {
		order.push("fence");
	});
	const drain = vi.fn(async () => {
		order.push("drain");
	});
	const secureSurface = vi.fn(async () => {
		order.push("secureSurface");
	});
	const call = vi.fn(async (_method: string, args: Record<string, unknown>) => {
		order.push("ack");
		const requested = args.p_challenge as { state: string; version: number; challengeId: string };
		return {
			state: requested.state === "entering" ? "private" : "shared",
			version: requested.version,
			challengeId: requested.challengeId,
		};
	});
	const supervisor = new CompanyComputerPrivacySupervisor({
		scope: computerScope(),
		drains: { drain },
		boundary: { fence, secureSurface },
		control: { call },
	});
	return { challenge, order, fence, drain, secureSurface, call, supervisor, signal: new AbortController().signal };
}

describe("office sign-in privacy", () => {
	it("waits for viewer shutdown, every screen and private surface preparation before ack", async () => {
		const f = fixture();
		const viewers = computerDeferred<void>();
		const surface = computerDeferred<void>();
		f.fence.mockImplementation(async () => {
			f.order.push("fence");
			await viewers.promise;
		});
		f.secureSurface.mockImplementation(async () => {
			f.order.push("secureSurface");
			await surface.promise;
		});
		const result = f.supervisor.transition(f.challenge, f.signal);
		await vi.waitFor(() => expect(f.fence).toHaveBeenCalledOnce());
		expect(f.drain).not.toHaveBeenCalled();
		viewers.resolve();
		await vi.waitFor(() => expect(f.secureSurface).toHaveBeenCalledOnce());
		expect(f.drain).toHaveBeenCalledTimes(2);
		expect(f.call).not.toHaveBeenCalled();
		surface.resolve();
		await result;
		expect(f.order).toEqual(["fence", "drain", "drain", "secureSurface", "ack"]);
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_ack_runtime_office_privacy",
			{ p_challenge: f.challenge },
			expect.any(AbortSignal),
		);
	});

	it.each(["fence", "drain", "secureSurface"] as const)(
		"retains failed %s and never acknowledges or resumes",
		async (stage) => {
			const f = fixture();
			f[stage].mockRejectedValue(new Error("physical state unknown"));
			await expect(f.supervisor.transition(f.challenge, f.signal)).rejects.toThrow("physical state unknown");
			f[stage].mockResolvedValue(undefined);
			await expect(f.supervisor.transition(f.challenge, f.signal)).rejects.toThrow();
			await expect(
				f.supervisor.transition(
					{ ...f.challenge, state: "leaving", version: 2, challengeId: computerId(47) },
					f.signal,
				),
			).rejects.toThrow();
			expect(f.call).not.toHaveBeenCalled();
			expect(f.fence).toHaveBeenCalledTimes(1);
		},
	);

	it("serializes entry/exit and requires a fresh full drain on exit", async () => {
		const f = fixture();
		const first = computerDeferred<void>();
		f.fence.mockImplementationOnce(async () => {
			f.order.push("fence");
			await first.promise;
		});
		const entering = f.supervisor.transition(f.challenge, f.signal);
		const leaving = { ...f.challenge, state: "leaving" as const, version: 2, challengeId: computerId(47) };
		const exiting = f.supervisor.transition(leaving, f.signal);
		await vi.waitFor(() => expect(f.fence).toHaveBeenCalledTimes(1));
		first.resolve();
		await Promise.all([entering, exiting]);
		expect(f.order).toEqual([
			"fence",
			"drain",
			"drain",
			"secureSurface",
			"ack",
			"fence",
			"drain",
			"drain",
			"secureSurface",
			"ack",
		]);
		await f.supervisor.transition(leaving, f.signal);
		expect(f.call).toHaveBeenCalledTimes(2);
		await expect(f.supervisor.transition(f.challenge, f.signal)).rejects.toThrow("OFFICE_PRIVACY_CHALLENGE_CHANGED");
	});

	it("keeps the original challenge after callers or adapters mutate their copies", async () => {
		const f = fixture();
		const original = structuredClone(f.challenge);
		const wait = computerDeferred<void>();
		f.fence.mockImplementation(async (...args: unknown[]) => {
			(args[0] as typeof original).profileId = computerId(99);
			await wait.promise;
		});
		const result = f.supervisor.transition(f.challenge, f.signal);
		f.challenge.drains.length = 0;
		f.challenge.profileId = computerId(98);
		wait.resolve();
		await result;
		expect(f.call.mock.calls[0][1].p_challenge).toEqual(original);
		expect(f.drain).toHaveBeenCalledTimes(2);
	});

	it("rejects changed or additional acknowledgement fields", async () => {
		const f = fixture();
		f.call.mockResolvedValue({ state: "private", version: 2, challengeId: f.challenge.challengeId });
		await expect(f.supervisor.transition(f.challenge, f.signal)).rejects.toThrow("OFFICE_PRIVACY_UNCONFIRMED");
		await expect(f.supervisor.transition(f.challenge, f.signal)).rejects.toThrow();
		expect(f.call).toHaveBeenCalledOnce();
	});

	it("rejects duplicate, foreign, stale-generation and missing target screens before physical changes", () => {
		const f = fixture();
		const invalid = [
			{ ...f.challenge, password: "must not cross this boundary" },
			{ ...f.challenge, drains: [] },
			{ ...f.challenge, drains: [f.challenge.drains[0], f.challenge.drains[0]] },
			{ ...f.challenge, computerGeneration: 2 },
			{ ...f.challenge, screenId: computerId(99) },
			{ ...f.challenge, scope: { ...computerScope(), companyId: computerId(99) } },
		];
		for (const value of invalid) expect(() => parseCompanyComputerPrivacyChallenge(value, computerScope())).toThrow();
		expect(f.fence).not.toHaveBeenCalled();
	});
});
