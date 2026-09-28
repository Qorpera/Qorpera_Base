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
