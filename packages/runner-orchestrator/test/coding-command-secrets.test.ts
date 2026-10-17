import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CodingCommandSecretRequest,
	type CodingCommandSecrets,
	type CodingEnvironmentScope,
	type CodingEnvironmentSource,
	CodingMachineCommandSecrets,
} from "../src/coding-command-secrets.ts";

// 5j-4: each session attached to an executor's machine gets its vault environment from the broker, asked once for
// each command, and every mask on the machine covers the values of every session attached to it, and of one released
// while another stays.

const API_KEY = "env-value-api-key-CANARY";
const ROTATED = "env-value-api-key-ROTATED";
const OTHER_KEY = "env-value-other-session-CANARY";
const AWAY_KEY = "env-value-other-machine-CANARY";

const signal = () => new AbortController().signal;

function masked(mask: { push(chunk: Uint8Array): Uint8Array; end(): Uint8Array }, text: string): string {
	return Buffer.concat([mask.push(new TextEncoder().encode(text)), mask.end()]).toString("utf8");
}

/** The mask a read of the command gets; the guest took the start the session resolved. */
async function readMask(secrets: CodingCommandSecrets, request: CodingCommandSecretRequest) {
	const masks = await secrets.output(request, signal());
	if (!masks) throw new Error("no mask");
	return masks();
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
	it("asks the broker once for each command, at its start, and masks its reads with that answer", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const request = f.request(machineId, scope);
		const started = await f.secrets.session(machineId, scope).resolve(request, signal());
		f.secrets.session(machineId, scope).accepted(request);
		expect(started.environment).toStrictEqual({ API_KEY });
		expect(Object.isFrozen(started.environment)).toBe(true);
		expect(f.environment).toHaveBeenCalledExactlyOnceWith(scope, expect.any(AbortSignal));
		expect(masked(started.mask(), `key=${API_KEY}\n`)).toBe("key=***\n");
		// Its reads, the second under a later turn's claim, are masked with the answer it started with, even once the
		// broker's answer has changed. A start again gets that answer too.
		f.environment.mockResolvedValue({ API_KEY: ROTATED });
		for (const at of [scope, f.scope(workerId)]) {
			const session = f.secrets.session(machineId, at);
			expect(masked(await readMask(session, request), `${API_KEY} ${ROTATED}`)).toBe(`*** ${ROTATED}`);
			expect((await session.resolve(request, signal())).environment).toBe(started.environment);
		}
		expect(f.environment).toHaveBeenCalledOnce();
		// A second command asks again, and gets the broker's answer now.
		const next = await f.secrets.session(machineId, scope).resolve(f.request(machineId, scope), signal());
		expect(next.environment).toStrictEqual({ API_KEY: ROTATED });
		expect(f.environment).toHaveBeenCalledTimes(2);
		// Each mask covers the values the session's commands were given.
		expect(masked(next.mask(), `${API_KEY} ${ROTATED}`)).toBe("*** ***");
		expect(masked(await readMask(f.secrets.session(machineId, scope), request), `${API_KEY} ${ROTATED}`)).toBe(
			"*** ***",
		);
	});

	it("masks the values of a session released while another stays, until the machine's last session goes", async () => {
		const mine = randomUUID();
		const other = randomUUID();
		const away = randomUUID();
		const f = fixture({ [mine]: { API_KEY }, [other]: { OTHER_KEY }, [away]: { AWAY_KEY } });
		const machineId = randomUUID();
		const theirs = f.scope(other);
		await f.secrets.session(machineId, theirs).resolve(f.request(machineId, theirs), signal());
		// A session on another machine is not covered.
		const elsewhere = randomUUID();
		const there = f.scope(away);
		await f.secrets.session(elsewhere, there).resolve(f.request(elsewhere, there), signal());
		const scope = f.scope(mine);
		const request = f.request(machineId, scope);
		const resolved = await f.secrets.session(machineId, scope).resolve(request, signal());
		f.secrets.session(machineId, scope).accepted(request);
		// Only its own values are in its environment, but root on the machine reaches the other session's.
		expect(resolved.environment).toStrictEqual({ API_KEY });
		const printed = `${API_KEY} ${OTHER_KEY} ${AWAY_KEY}`;
		expect(masked(resolved.mask(), printed)).toBe(`*** *** ${AWAY_KEY}`);
		// The other session goes. The command may have printed its value before then, in output not kept yet, so its
		// reads still mask it, and so does a command that starts later.
		f.secrets.release(machineId, other);
		expect(masked(await readMask(f.secrets.session(machineId, scope), request), printed)).toBe(`*** *** ${AWAY_KEY}`);
		const later = await f.secrets.session(machineId, scope).resolve(f.request(machineId, scope), signal());
		expect(masked(later.mask(), printed)).toBe(`*** *** ${AWAY_KEY}`);
		// The machine's last session goes: nothing of the machine is kept. Its commands' reads have no mask, and a new
		// session's masks cover only what it is given.
		f.secrets.release(machineId, mine);
		expect(await f.secrets.session(machineId, scope).output(request, signal())).toBeNull();
		const again = f.scope(mine);
		const next = await f.secrets.session(machineId, again).resolve(f.request(machineId, again), signal());
		expect(masked(next.mask(), printed)).toBe(`*** ${OTHER_KEY} ${AWAY_KEY}`);
		expect(f.environment).toHaveBeenCalledTimes(5);
	});

	it("has no mask for a command until the guest takes the start it resolved", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const session = f.secrets.session(machineId, scope);
		// An executor before this one started it: the values it runs with are not known here, and none is asked for.
		const before = f.request(machineId, scope);
		session.accepted(before);
		expect(await session.output(before, signal())).toBeNull();
		expect(f.environment).not.toHaveBeenCalled();
		// Resolved, but the guest's answer to the start was lost, or it refused it: the guest may run the command with an
		// earlier start's environment.
		const request = f.request(machineId, scope);
		const started = await session.resolve(request, signal());
		expect(await session.output(request, signal())).toBeNull();
		// Its answer still masks the machine's other commands.
		f.environment.mockResolvedValueOnce({ API_KEY: ROTATED });
		const next = await session.resolve(f.request(machineId, scope), signal());
		expect(masked(next.mask(), `${API_KEY} ${ROTATED}`)).toBe("*** ***");
		// A start again sends the same environment without asking. Once the guest takes it, the command's reads are masked.
		expect((await session.resolve(request, signal())).environment).toBe(started.environment);
		session.accepted(request);
		expect(masked(await readMask(session, request), `${API_KEY} ${ROTATED}`)).toBe("*** ***");
		expect(f.environment).toHaveBeenCalledTimes(2);
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
		await expect(f.secrets.session(machineId, scope).output(request, aborted.signal)).rejects.toThrow("stopped");
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
		const mine = f.secrets.session(machineId, scope);
		for (const differs of [
			{ ...request, machineId: randomUUID() },
			{ ...request, workerId: randomUUID() },
			{ ...request, companyId: randomUUID() },
		]) {
			await expect(mine.resolve(differs, signal())).rejects.toThrow("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
			await expect(mine.output(differs, signal())).rejects.toThrow("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
			expect(() => mine.accepted(differs)).toThrow("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
		}
		expect(f.environment).toHaveBeenCalledTimes(2);
	});
});
