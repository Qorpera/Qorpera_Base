import { CloudModelLoginUpkeep } from "@qorpera/runtime/cloud-model-login-upkeep";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.useRealTimers();
});

function vault(outcomes: ReadonlyArray<"renewed" | "failed" | "none" | Error>) {
	let call = 0;
	return {
		renewIdle: vi.fn(async (_signal: AbortSignal): Promise<"renewed" | "failed" | "none"> => {
			const outcome = outcomes[Math.min(call, outcomes.length - 1)];
			call += 1;
			if (outcome instanceof Error) throw outcome;
			return outcome ?? "none";
		}),
		recordAccounts: vi.fn(async (_signal: AbortSignal) => 0),
		switchOffReplacedNodeLogins: vi.fn(async (_signal: AbortSignal) => ({ switchedOff: 0, waiting: 0, refused: 0 })),
	};
}

it("renews due logins one at a time until none is left, past a failed one", async () => {
	const logins = vault(["renewed", "failed", "renewed", "none"]);
	await new CloudModelLoginUpkeep({ vault: logins }).pass();
	expect(logins.renewIdle).toHaveBeenCalledTimes(4);
	expect(logins.renewIdle).toHaveBeenCalledWith(expect.any(AbortSignal));
});

it("stops a pass after an error or twelve renewals, and logs only that it stopped", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const failing = vault([new Error("login 6f0c private detail")]);
	await new CloudModelLoginUpkeep({ vault: failing }).pass();
	expect(failing.renewIdle).toHaveBeenCalledTimes(1);
	expect(log).toHaveBeenCalledExactlyOnceWith(
		"Model login upkeep: a pass stopped on an error; the next pass tries again.",
	);
	log.mockRestore();
	const busy = vault(["renewed"]);
	await new CloudModelLoginUpkeep({ vault: busy }).pass();
	expect(busy.renewIdle).toHaveBeenCalledTimes(12);
});

it("records accounts and switches off replaced node logins before renewing, and logs only facts", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const logins = vault(["none"]);
	const order: string[] = [];
	logins.recordAccounts.mockImplementation(async () => {
		order.push("accounts");
		return 1;
	});
	logins.switchOffReplacedNodeLogins.mockImplementation(async () => {
		order.push("switch-off");
		return { switchedOff: 2, waiting: 1, refused: 0 };
	});
	logins.renewIdle.mockImplementation(async () => {
		order.push("renew");
		return "none";
	});
	await new CloudModelLoginUpkeep({ vault: logins }).pass();
	expect(order).toEqual(["accounts", "switch-off", "renew"]);
	expect(log).toHaveBeenCalledExactlyOnceWith(
		"Model login upkeep: switched off 2 old node login(s) the vault replaced.",
	);

	// A failing part is logged by fact only, and the rest of the pass still runs.
	log.mockClear();
	logins.recordAccounts.mockRejectedValueOnce(new Error("login 6f0c private detail"));
	logins.switchOffReplacedNodeLogins.mockRejectedValueOnce(new Error("member private detail"));
	order.length = 0;
	await new CloudModelLoginUpkeep({ vault: logins }).pass();
	expect(order).toEqual(["renew"]);
	expect(log.mock.calls).toEqual([
		["Model login upkeep: recording login accounts failed; the next pass tries again."],
		["Model login upkeep: the switch-off pass failed; the next pass tries again."],
	]);
	log.mockRestore();
});

it("runs a pass after the first wait and then every pass, until closed", async () => {
	vi.useFakeTimers();
	const logins = vault(["none"]);
	const upkeep = new CloudModelLoginUpkeep({ vault: logins, passEveryMs: 1000, firstPassMs: 200 });
	upkeep.start();
	upkeep.start();
	await vi.advanceTimersByTimeAsync(199);
	expect(logins.renewIdle).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(logins.renewIdle).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(logins.renewIdle).toHaveBeenCalledTimes(2);
	await upkeep.close();
	await vi.advanceTimersByTimeAsync(5000);
	expect(logins.renewIdle).toHaveBeenCalledTimes(2);
	upkeep.start();
	await vi.advanceTimersByTimeAsync(5000);
	expect(logins.renewIdle).toHaveBeenCalledTimes(2);
});
