import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CodingCommandSecretRequest,
	type CodingEnvironmentScope,
	type CodingEnvironmentSource,
	CodingMachineCommandSecrets,
} from "../src/coding-command-secrets.ts";

// 5j-4: each session attached to an executor's machine gets its vault environment from the broker, asked once for
// each command, and every mask on the machine covers every live session's values.

const API_KEY = "env-value-api-key-CANARY";
const OTHER_KEY = "env-value-other-session-CANARY";

const signal = () => new AbortController().signal;

function masked(mask: { push(chunk: Uint8Array): Uint8Array; end(): Uint8Array }, text: string): string {
	return Buffer.concat([mask.push(new TextEncoder().encode(text)), mask.end()]).toString("utf8");
}

/** A broker that answers each session's environment from `answers`, by worker. */
function fixture(answers: Record<string, Readonly<Record<string, string>>> = {}) {
	const environment = vi.fn<CodingEnvironmentSource["environment"]>(async (scope) => {
		const answer = answers[scope.workerId];
		if (!answer) throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		return { ...answer };
	});
	const secrets = new CodingMachineCommandSecrets({ environment });
	const companyId = randomUUID();
	const scope = (workerId = randomUUID()): CodingEnvironmentScope => ({
		companyId,
		workerId,
		leaseToken: randomUUID(),
	});
	const request = (
		machineId: string,
		at: CodingEnvironmentScope,
		commandId = randomUUID(),
	): CodingCommandSecretRequest => ({
		companyId: at.companyId,
		workerId: at.workerId,
		machineId,
		commandId,
		kind: "command",
	});
	return { environment, secrets, scope, request };
}

describe("a coding session's command secrets on its machine", () => {
	it("asks the broker once for each command, across its start and its reads", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const request = f.request(machineId, scope);
		const started = await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(started.environment).toStrictEqual({ API_KEY });
		expect(Object.isFrozen(started.environment)).toBe(true);
		expect(f.environment).toHaveBeenCalledExactlyOnceWith(scope, expect.any(AbortSignal));
		expect(masked(started.mask(), `key=${API_KEY}\n`)).toBe("key=***\n");
		// Its reads, the second under a later turn's claim, get the answer it started with, even once the broker's
		// answer has changed.
		f.environment.mockResolvedValue({ API_KEY: "env-value-api-key-ROTATED" });
		for (const at of [scope, f.scope(workerId)]) {
			const read = await f.secrets.session(machineId, at).resolve(request, signal());
			expect(read.environment).toBe(started.environment);
			expect(masked(read.mask(), `${API_KEY} env-value-api-key-ROTATED`)).toBe("*** env-value-api-key-ROTATED");
		}
		expect(f.environment).toHaveBeenCalledOnce();
		// A second command asks again, and gets the broker's answer now.
		const next = await f.secrets.session(machineId, scope).resolve(f.request(machineId, scope), signal());
		expect(next.environment).toStrictEqual({ API_KEY: "env-value-api-key-ROTATED" });
		expect(f.environment).toHaveBeenCalledTimes(2);
		// Each mask covers the values the session's commands were given.
		expect(masked(next.mask(), `${API_KEY} env-value-api-key-ROTATED`)).toBe("*** ***");
	});

	it("masks another live session's values on the same machine until that session is released", async () => {
		const mine = randomUUID();
		const other = randomUUID();
		const f = fixture({ [mine]: { API_KEY }, [other]: { OTHER_KEY } });
		const machineId = randomUUID();
		const elsewhere = randomUUID();
		const scope = f.scope(mine);
		await f.secrets.session(machineId, f.scope(other)).resolve(f.request(machineId, f.scope(other)), signal());
		const request = f.request(machineId, scope);
		const resolved = await f.secrets.session(machineId, scope).resolve(request, signal());
		// Only its own values are in its environment, but root on the machine reaches the other session's.
		expect(resolved.environment).toStrictEqual({ API_KEY });
		expect(masked(resolved.mask(), `${API_KEY} ${OTHER_KEY}`)).toBe("*** ***");
		// A session on another machine is not covered.
		const away = f.scope(other);
		await f.secrets.session(elsewhere, away).resolve(f.request(elsewhere, away), signal());
		f.secrets.release(machineId, other);
		const after = await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(masked(after.mask(), `${API_KEY} ${OTHER_KEY}`)).toBe(`*** ${OTHER_KEY}`);
		// Released, a session's own commands ask again.
		f.secrets.release(machineId, mine);
		await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(f.environment).toHaveBeenCalledTimes(4);
	});

	it("fails the call when the ask fails, and asks again next time", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const request = f.request(machineId, scope);
		f.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(f.secrets.session(machineId, scope).resolve(request, signal())).rejects.toThrow(
			"CODING_ENVIRONMENT_UNAVAILABLE",
		);
		const resolved = await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(resolved.environment).toStrictEqual({ API_KEY });
		expect(f.environment).toHaveBeenCalledTimes(2);
		// A value too short to mask fails the ask without naming it and keeps nothing, so the next command's mask, which
		// covers every value kept on the machine, still builds.
		const short = randomUUID();
		const g = fixture({ [short]: { SHORT: "seven77" } });
		const at = g.scope(short);
		const failed = await g.secrets
			.session(machineId, at)
			.resolve(g.request(machineId, at), signal())
			.catch((error: unknown) => error as Error);
		expect(failed).toBeInstanceOf(RangeError);
		expect(String(failed)).not.toContain("seven77");
		g.environment.mockResolvedValueOnce({ API_KEY });
		const next = await g.secrets.session(machineId, at).resolve(g.request(machineId, at), signal());
		expect(next.environment).toStrictEqual({ API_KEY });
		expect(masked(next.mask(), "seven77 ok")).toBe("seven77 ok");
	});

	it("honours the abort signal, before it asks and while it asks", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const request = f.request(machineId, scope);
		const aborted = new AbortController();
		aborted.abort(new Error("stopped"));
		await expect(f.secrets.session(machineId, scope).resolve(request, aborted.signal)).rejects.toThrow("stopped");
		expect(f.environment).not.toHaveBeenCalled();
		// Aborted while the broker answers: the answer is not kept, so the next resolve asks again.
		const asking = new AbortController();
		f.environment.mockImplementationOnce(async (_scope, given) => {
			expect(given).toBe(asking.signal);
			asking.abort(new Error("stopped"));
			return { API_KEY };
		});
		await expect(f.secrets.session(machineId, scope).resolve(request, asking.signal)).rejects.toThrow("stopped");
		await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(f.environment).toHaveBeenCalledTimes(2);
	});

	it("keeps nothing for a session released while it asked, and refuses another session's request", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const request = f.request(machineId, scope);
		const session = f.secrets.session(machineId, scope);
		f.environment.mockImplementationOnce(async () => {
			f.secrets.release(machineId, workerId);
			return { API_KEY };
		});
		await expect(session.resolve(request, signal())).rejects.toThrow("CODING_COMMAND_SECRETS_RELEASED");
		const other = f.scope(workerId);
		const mask = (await f.secrets.session(machineId, other).resolve(f.request(machineId, other), signal())).mask();
		expect(masked(mask, API_KEY)).toBe("***");
		expect(f.environment).toHaveBeenCalledTimes(2);
		for (const differs of [
			{ ...request, machineId: randomUUID() },
			{ ...request, workerId: randomUUID() },
			{ ...request, companyId: randomUUID() },
		])
			await expect(f.secrets.session(machineId, scope).resolve(differs, signal())).rejects.toThrow(
				"CODING_COMMAND_SECRETS_SCOPE_DIFFERS",
			);
		expect(f.environment).toHaveBeenCalledTimes(2);
	});
});
