import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CodingCommandSecretRequest,
	type CodingCommandSecrets,
	type CodingEnvironmentAnswer,
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
const OLDER_KEY = "env-value-api-key-OLDER";

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

/** The vault's answer: the environment, and the older values used on the machine. */
function answer(environment: Readonly<Record<string, string>>, mask: readonly string[] = []): CodingEnvironmentAnswer {
	return { environment, mask };
}

/** A broker that answers each session's environment from `answers`, by worker, with the older values in `history`. */
function fixture(
	answers: Record<string, Readonly<Record<string, string>>> = {},
	history: Record<string, readonly string[]> = {},
) {
	const environment = vi.fn<CodingEnvironmentSource["environment"]>(async (scope) => {
		const found = answers[scope.workerId];
		if (!found) throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		return answer({ ...found }, history[scope.workerId]);
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
		f.environment.mockResolvedValue(answer({ API_KEY: ROTATED }));
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

	it("masks the vault's older values for the machine in every session's masks, never in an environment", async () => {
		const mine = randomUUID();
		const other = randomUUID();
		const away = randomUUID();
		// The vault answers the values used on the machine before a rotation, as after an executor restart.
		const f = fixture(
			{ [mine]: { API_KEY: ROTATED }, [other]: { OTHER_KEY }, [away]: { AWAY_KEY } },
			{ [mine]: [API_KEY, OLDER_KEY] },
		);
		const machineId = randomUUID();
		const theirs = f.scope(other);
		const before = f.request(machineId, theirs);
		await f.secrets.session(machineId, theirs).resolve(before, signal());
		f.secrets.session(machineId, theirs).accepted(before);
		const elsewhere = randomUUID();
		const there = f.scope(away);
		const far = await f.secrets.session(elsewhere, there).resolve(f.request(elsewhere, there), signal());
		const scope = f.scope(mine);
		const request = f.request(machineId, scope);
		const resolved = await f.secrets.session(machineId, scope).resolve(request, signal());
		f.secrets.session(machineId, scope).accepted(request);
		expect(resolved.environment).toStrictEqual({ API_KEY: ROTATED });
		const printed = `${API_KEY} ${OLDER_KEY} ${ROTATED} ${OTHER_KEY}`;
		expect(masked(resolved.mask(), printed)).toBe("*** *** *** ***");
		// The other session's reads, and its later starts, mask them too; nothing of them goes into its environment, and
		// another machine's masks do not cover them.
		expect(masked(await readMask(f.secrets.session(machineId, theirs), before), printed)).toBe("*** *** *** ***");
		const later = await f.secrets.session(machineId, theirs).resolve(f.request(machineId, theirs), signal());
		expect(later.environment).toStrictEqual({ OTHER_KEY });
		expect(masked(later.mask(), printed)).toBe("*** *** *** ***");
		expect(masked(far.mask(), printed)).toBe(`${API_KEY} ${OLDER_KEY} ${ROTATED} ${OTHER_KEY}`);
		// A start again does not ask, and its mask still covers them; so do my reads once the other session goes.
		expect((await f.secrets.session(machineId, scope).resolve(request, signal())).environment).toBe(
			resolved.environment,
		);
		f.secrets.release(machineId, other);
		expect(masked(await readMask(f.secrets.session(machineId, scope), request), printed)).toBe("*** *** *** ***");
		expect(f.environment).toHaveBeenCalledTimes(4);
		// The machine's last session goes: its older values go with it, until an answer names them again.
		f.secrets.release(machineId, mine);
		const again = f.scope(other);
		const next = await f.secrets.session(machineId, again).resolve(f.request(machineId, again), signal());
		expect(masked(next.mask(), printed)).toBe(`${API_KEY} ${OLDER_KEY} ${ROTATED} ***`);
	});

	it("fails the ask when an older value cannot be masked, and keeps nothing of the answer", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } }, { [workerId]: [OLDER_KEY, "seven77"] });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		const failed = await f.secrets
			.session(machineId, scope)
			.resolve(f.request(machineId, scope), signal())
			.catch((error: unknown) => error as Error);
		expect(failed).toBeInstanceOf(RangeError);
		expect(String(failed)).not.toContain("seven77");
		// Neither the environment nor the older values of the refused answer are kept.
		f.environment.mockResolvedValueOnce(answer({ API_KEY: ROTATED }));
		const next = await f.secrets.session(machineId, scope).resolve(f.request(machineId, scope), signal());
		expect(next.environment).toStrictEqual({ API_KEY: ROTATED });
		expect(masked(next.mask(), `${API_KEY} ${OLDER_KEY} ${ROTATED}`)).toBe(`${API_KEY} ${OLDER_KEY} ***`);
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
		f.environment.mockResolvedValueOnce(answer({ API_KEY: ROTATED }));
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
		g.environment.mockResolvedValueOnce(answer({ API_KEY }));
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
			return answer({ API_KEY });
		});
		await expect(f.secrets.session(machineId, scope).resolve(request, asking.signal)).rejects.toThrow("stopped");
		await f.secrets.session(machineId, scope).resolve(request, signal());
		expect(f.environment).toHaveBeenCalledTimes(2);
	});

	it("checks a publication against every value kept for the machine and the session's environment asked again, with its older values", async () => {
		const mine = randomUUID();
		const other = randomUUID();
		const f = fixture({ [mine]: { API_KEY }, [other]: { OTHER_KEY } });
		const machineId = randomUUID();
		const theirs = f.scope(other);
		await f.secrets.session(machineId, theirs).resolve(f.request(machineId, theirs), signal());
		const scope = f.scope(mine);
		const request = f.request(machineId, scope);
		await f.secrets.session(machineId, scope).resolve(request, signal());
		f.secrets.session(machineId, scope).accepted(request);
		// The value changed since the command started: the publication is checked for both, under its own claim, and no
		// command keeps the new answer. The older value that answer names is checked too, and the machine's masks keep it.
		f.environment.mockResolvedValueOnce(answer({ API_KEY: ROTATED }, [OLDER_KEY]));
		const publishing = f.scope(mine);
		const mask = await f.secrets.publication(machineId, publishing, signal());
		expect(f.environment).toHaveBeenLastCalledWith(publishing, expect.any(AbortSignal));
		expect(f.environment).toHaveBeenCalledTimes(3);
		expect(masked(mask.stream(), `${API_KEY} ${ROTATED} ${OTHER_KEY} ${OLDER_KEY}`)).toBe("*** *** *** ***");
		expect(masked(await readMask(f.secrets.session(machineId, scope), request), `${ROTATED} ${OLDER_KEY}`)).toBe(
			`${ROTATED} ***`,
		);
		// A session that ran no command in this process (the executor restarted since) is checked against its
		// environment now.
		const restarted = fixture({ [mine]: { API_KEY } });
		const fresh = await restarted.secrets.publication(machineId, restarted.scope(mine), signal());
		expect(masked(fresh.stream(), `${API_KEY} ${OTHER_KEY}`)).toBe(`*** ${OTHER_KEY}`);
		// A failed ask fails it, and so does an abort or a release while it asks.
		f.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(f.secrets.publication(machineId, scope, signal())).rejects.toThrow("CODING_ENVIRONMENT_UNAVAILABLE");
		const aborted = new AbortController();
		aborted.abort(new Error("stopped"));
		await expect(f.secrets.publication(machineId, scope, aborted.signal)).rejects.toThrow("stopped");
		expect(f.environment).toHaveBeenCalledTimes(4);
		f.environment.mockImplementationOnce(async () => {
			f.secrets.release(machineId, mine);
			return answer({ API_KEY });
		});
		await expect(f.secrets.publication(machineId, scope, signal())).rejects.toThrow(
			"CODING_COMMAND_SECRETS_RELEASED",
		);
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
			return answer({ API_KEY });
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

describe("a coding machine's values for the folder service's save check (5j-5 (a))", () => {
	const sorted = (values: readonly string[] | undefined) => (values ? [...values].sort() : values);

	it("knows a machine's values once this process has a vault answer for it, until its last session goes", async () => {
		const mine = randomUUID();
		const other = randomUUID();
		const away = randomUUID();
		const f = fixture({ [mine]: { API_KEY }, [other]: { OTHER_KEY }, [away]: { AWAY_KEY } }, { [mine]: [OLDER_KEY] });
		const machineId = randomUUID();
		const scope = f.scope(mine);
		// Nothing asked here yet: what is known of the machine is not all.
		expect(f.secrets.values(machineId)).toBeUndefined();
		f.secrets.session(machineId, scope);
		expect(f.secrets.values(machineId)).toBeUndefined();
		// The attach asks the vault under the session's claim, so they are known before a command starts.
		await f.secrets.attached(machineId, scope, signal());
		expect(f.environment).toHaveBeenLastCalledWith(scope, expect.any(AbortSignal));
		expect(sorted(f.secrets.values(machineId))).toEqual([API_KEY, OLDER_KEY].sort());
		// Another session's command on the machine; one on another machine is not the machine's.
		const theirs = f.scope(other);
		await f.secrets.session(machineId, theirs).resolve(f.request(machineId, theirs), signal());
		const elsewhere = randomUUID();
		const there = f.scope(away);
		await f.secrets.session(elsewhere, there).resolve(f.request(elsewhere, there), signal());
		expect(sorted(f.secrets.values(machineId))).toEqual([API_KEY, OLDER_KEY, OTHER_KEY].sort());
		expect(f.secrets.values(elsewhere)).toEqual([AWAY_KEY]);
		// A session released while another stays: still masked, so still the machine's.
		f.secrets.release(machineId, other);
		expect(sorted(f.secrets.values(machineId))).toEqual([API_KEY, OLDER_KEY, OTHER_KEY].sort());
		f.secrets.release(machineId, mine);
		expect(f.secrets.values(machineId)).toBeUndefined();
		// A command's start makes them known too.
		const again = f.scope(mine);
		await f.secrets.session(machineId, again).resolve(f.request(machineId, again), signal());
		expect(sorted(f.secrets.values(machineId))).toEqual([API_KEY, OLDER_KEY].sort());
	});

	it("knows a member with no secrets as none, from the attach on", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: {} });
		const machineId = randomUUID();
		await f.secrets.attached(machineId, f.scope(workerId), signal());
		expect(f.secrets.values(machineId)).toEqual([]);
	});

	it("masks the answer the attach asked for in the machine's commands, and never puts it in an environment", async () => {
		const workerId = randomUUID();
		const answers: Record<string, Readonly<Record<string, string>>> = { [workerId]: { API_KEY } };
		const f = fixture(answers);
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		await f.secrets.attached(machineId, scope, signal());
		// Rotated before the first command starts: it gets the new value, and its output's mask covers both.
		answers[workerId] = { API_KEY: ROTATED };
		const resolved = await f.secrets.session(machineId, scope).resolve(f.request(machineId, scope), signal());
		expect(resolved.environment).toStrictEqual({ API_KEY: ROTATED });
		expect(masked(resolved.mask(), `${API_KEY} ${ROTATED}`)).toBe("*** ***");
		expect(sorted(f.secrets.values(machineId))).toEqual([API_KEY, ROTATED].sort());
	});

	it("keeps nothing of an attach whose ask fails, is refused by the mask, or outlives the session", async () => {
		const workerId = randomUUID();
		const f = fixture({ [workerId]: { API_KEY } });
		const machineId = randomUUID();
		const scope = f.scope(workerId);
		f.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(f.secrets.attached(machineId, scope, signal())).rejects.toThrow("CODING_ENVIRONMENT_UNAVAILABLE");
		expect(f.secrets.values(machineId)).toBeUndefined();
		f.environment.mockResolvedValueOnce(answer({ SHORT: "short" }));
		await expect(f.secrets.attached(machineId, scope, signal())).rejects.toThrow(RangeError);
		expect(f.secrets.values(machineId)).toBeUndefined();
		f.environment.mockImplementationOnce(async () => {
			f.secrets.release(machineId, workerId);
			return answer({ API_KEY });
		});
		await expect(f.secrets.attached(machineId, scope, signal())).rejects.toThrow("CODING_COMMAND_SECRETS_RELEASED");
		expect(f.secrets.values(machineId)).toBeUndefined();
		const controller = new AbortController();
		controller.abort(new Error("turn ended"));
		await expect(f.secrets.attached(machineId, scope, controller.signal)).rejects.toThrow("turn ended");
		expect(f.environment).toHaveBeenCalledTimes(3);
		expect(f.secrets.values(machineId)).toBeUndefined();
	});
});
