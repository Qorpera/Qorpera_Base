import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberMachineScreenControl } from "../../../deploy/coding-worker/member-control.ts";
import { CloudMemberMachineActRefusal, CloudMemberMachineScreenRefusal } from "../src/cloud-machine-command-http.ts";
import {
	type CloudMemberMachineActRequest,
	CloudMemberMachineScreenForbidden,
	type CloudMemberMachineScreenLook,
	CloudMemberMachineScreenSignIn,
	HttpCloudMemberMachineScreenService,
} from "../src/cloud-member-machine-screen-http.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const picture = Buffer.from("89504e470d0a1a0a0000000d4948445200000640000003e8", "hex");
const etag = createHash("sha256").update(picture).digest("hex");
const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZW1iZXIifQ.c2lnbmF0dXJl";

async function service(
	look: (request: CloudMemberMachineScreenLook) => Promise<{ etag: string; png: Buffer | null }>,
	act?: (request: CloudMemberMachineActRequest) => Promise<{ exitCode: number | null }>,
) {
	const failed = vi.fn();
	const looked = vi.fn(look);
	const acted = vi.fn(act ?? (async () => ({ exitCode: 0 })));
	const http = new HttpCloudMemberMachineScreenService({ look: looked, failed, ...(act ? { act: acted } : {}) });
	const port = await http.start();
	cleanups.push(() => http.close());
	const companyId = randomUUID();
	const machineId = randomUUID();
	const url = (suffix = "") => `http://127.0.0.1:${port}/v1/member-machine-screens/${companyId}/${machineId}${suffix}`;
	return { looked, acted, failed, url, companyId, machineId, port };
}

describe("a member's look through the executor's member listener (20260930712000)", () => {
	it("answers the picture with its etag, the same picture as 304, and passes the member's token and word on", async () => {
		const s = await service(async (request) => ({ etag, png: request.etag === etag ? null : picture }));
		const shown = await fetch(s.url(), { headers: { authorization: `Bearer ${token}` } });
		expect(shown.status).toBe(200);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("etag")).toBe(`"${etag}"`);
		expect(shown.headers.get("cache-control")).toBe("private, no-store");
		expect(Buffer.from(await shown.arrayBuffer())).toEqual(picture);
		expect(s.looked).toHaveBeenLastCalledWith(
			{ companyId: s.companyId, machineId: s.machineId, token, confirmed: false, etag: null },
			expect.any(AbortSignal),
		);
		// The member has it: 304 with the etag and no body; `/watching` says they still watch.
		const same = await fetch(s.url("/watching"), {
			headers: { authorization: `Bearer ${token}`, "if-none-match": `"${etag}"` },
		});
		expect(same.status).toBe(304);
		expect(same.headers.get("etag")).toBe(`"${etag}"`);
		expect(await same.text()).toBe("");
		expect(s.looked).toHaveBeenLastCalledWith(
			expect.objectContaining({ confirmed: true, etag }),
			expect.any(AbortSignal),
		);
		// An etag that is not one of ours is no etag.
		await (
			await fetch(s.url(), { headers: { authorization: `Bearer ${token}`, "if-none-match": `W/"${etag}"` } })
		).arrayBuffer();
		expect(s.looked).toHaveBeenLastCalledWith(expect.objectContaining({ etag: null }), expect.any(AbortSignal));
	});

	it("tells refusals by code, a token the database refused as 401, a machine not the member's as 403, and fails closed", async () => {
		let next: unknown;
		const s = await service(async () => {
			throw next;
		});
		const ask = async () => {
			const response = await fetch(s.url(), { headers: { authorization: `Bearer ${token}` } });
			return { status: response.status, body: await response.text(), etag: response.headers.get("etag") };
		};
		next = new CloudMemberMachineScreenRefusal("SCREEN_HIDDEN");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "SCREEN_HIDDEN" }), etag: null });
		next = new CloudMemberMachineScreenSignIn();
		expect((await ask()).status).toBe(401);
		next = new CloudMemberMachineScreenForbidden();
		expect((await ask()).status).toBe(403);
		next = new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		expect(await ask()).toEqual({
			status: 503,
			body: JSON.stringify({ error: "machine_screen_unavailable" }),
			etag: null,
		});
		expect(s.failed).toHaveBeenLastCalledWith("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		// An error that carries anything else is logged as UNCLASSIFIED, and never answered.
		next = new Error(`fetch failed for Bearer ${token}`);
		const failed = await ask();
		expect(failed.status).toBe(503);
		expect(failed.body).not.toContain(token);
		expect(s.failed).toHaveBeenLastCalledWith("UNCLASSIFIED");
		expect(JSON.stringify(s.failed.mock.calls)).not.toContain(token);
	});

	it("asks nothing without the member's bearer token, on another path, with a query or another method", async () => {
		const s = await service(async () => ({ etag, png: picture }));
		const status = async (url: string, init: RequestInit = {}) => (await fetch(url, init)).status;
		expect(await status(s.url())).toBe(401);
		expect(await status(s.url(), { headers: { authorization: "Basic abc" } })).toBe(401);
		expect(await status(s.url(), { headers: { authorization: `Bearer ${token} more` } })).toBe(401);
		const signedIn = { authorization: `Bearer ${token}` };
		expect(await status(s.url("?x=1"), { headers: signedIn })).toBe(404);
		expect(await status(s.url("/keep"), { headers: signedIn })).toBe(404);
		expect(await status(s.url().replace(s.machineId, "machine"), { headers: signedIn })).toBe(404);
		expect(await status(s.url().replace(s.companyId, s.companyId.toUpperCase()), { headers: signedIn })).toBe(404);
		expect(await status(`http://127.0.0.1:${s.port}/v1/member-folder-objects/x`, { headers: signedIn })).toBe(404);
		expect(await status(s.url(), { method: "POST", headers: signedIn, body: "{}" })).toBe(405);
		expect(s.looked).not.toHaveBeenCalled();
	});

	it("listens on loopback only", async () => {
		expect(
			() =>
				new HttpCloudMemberMachineScreenService({
					look: async () => ({ etag, png: null }),
					host: "0.0.0.0" as "::1",
				}),
		).toThrow("MEMBER_MACHINE_SCREEN_CONFIG_INVALID");
		expect(
			() => new HttpCloudMemberMachineScreenService({ look: async () => ({ etag, png: null }), port: 70000 }),
		).toThrow("MEMBER_MACHINE_SCREEN_CONFIG_INVALID");
	});
});

describe("a member's action through the executor's member listener (20260930713000)", () => {
	const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});

	it("passes one action, the member's token and its text to the executor, and answers only its exit", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			async () => ({ exitCode: 0 }),
		);
		const done = await post(s.url("/act"), { action: { type: "type", text: "hunter2 Åse" }, epoch: 3 });
		expect(done.status).toBe(200);
		expect(done.headers.get("cache-control")).toBe("no-store");
		expect(await done.json()).toEqual({ schema: "qorpera.member-machine-act/v1", exitCode: 0 });
		expect(s.acted).toHaveBeenLastCalledWith(
			{
				companyId: s.companyId,
				machineId: s.machineId,
				token,
				action: { type: "type", text: "hunter2 Åse" },
				epoch: 3,
			},
			expect.any(AbortSignal),
		);
		// The epoch of the hold the input was captured under goes on as it came (F24), 0 too.
		await post(s.url("/act"), { epoch: 0, action: { type: "click", x: 812, y: 443, button: "right" } });
		expect(s.acted).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: { type: "click", x: 812, y: 443, button: "right" }, epoch: 0 }),
			expect.any(AbortSignal),
		);
		expect(s.looked).not.toHaveBeenCalled();
	});

	it("refuses a body that is not one action of a member's as 400, by method and token first, and never tells the text", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			async () => ({ exitCode: 0 }),
		);
		const status = async (response: Promise<Response>) => {
			const answered = await response;
			const text = await answered.text();
			expect(text).not.toContain("hunter2");
			return answered.status;
		};
		for (const body of [
			{ action: { type: "open", target: "https://bank.example.test" }, epoch: 1 },
			{ action: { type: "type", text: "hunter2" }, epoch: 1 },
			{ action: { type: "type", text: "x".repeat(501) }, epoch: 1 },
			{ action: { type: "key", keys: ["exec", "id"] }, epoch: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, intent: "x" },
			{ act: { type: "click", x: 1, y: 2 }, epoch: 1 },
			// The epoch is never guessed (F24): missing, below 0, not whole, too large, or not a number.
			{ action: { type: "click", x: 1, y: 2 } },
			{ action: { type: "click", x: 1, y: 2 }, epoch: -1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1.5 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 2 ** 53 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: "1" },
			{ action: { type: "click", x: 1, y: 2 }, epoch: null },
			[{ type: "click", x: 1, y: 2 }],
			"not json hunter2",
			JSON.stringify({ action: { type: "type", text: "y".repeat(400) }, epoch: 1, pad: "z".repeat(17000) }),
		])
			expect(await status(post(s.url("/act"), body)), JSON.stringify(body).slice(0, 80)).toBe(400);
		expect(
			await status(
				post(s.url("/act"), { action: { type: "click", x: 1, y: 2 }, epoch: 1 }, { "content-type": "text/plain" }),
			),
		).toBe(400);
		expect(s.acted).not.toHaveBeenCalled();
		// The look's routes take no POST; the action's takes no GET; and no token, no action.
		expect(await status(fetch(s.url("/act"), { headers: { authorization: `Bearer ${token}` } }))).toBe(405);
		expect(await status(post(s.url("/watching"), { action: { type: "click", x: 1, y: 2 }, epoch: 1 }))).toBe(405);
		expect(
			await status(
				fetch(s.url("/act"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: { type: "type", text: "hunter2" }, epoch: 1 }),
				}),
			),
		).toBe(401);
		expect(s.acted).not.toHaveBeenCalled();
		// A listener without actions has no such route.
		const looksOnly = await service(async () => ({ etag, png: picture }));
		expect(await status(post(looksOnly.url("/act"), { action: { type: "click", x: 1, y: 2 }, epoch: 1 }))).toBe(404);
	});

	it("tells refusals by code, a token the database refused as 401, and logs only a fixed code, never the text", async () => {
		let next: unknown;
		const s = await service(
			async () => ({ etag, png: picture }),
			async () => {
				throw next;
			},
		);
		const ask = async () => {
			const response = await post(s.url("/act"), { action: { type: "type", text: "hunter2" }, epoch: 1 });
			return { status: response.status, body: await response.text() };
		};
		next = new CloudMemberMachineActRefusal("DESKTOP_CONTROL_ENDED");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "DESKTOP_CONTROL_ENDED" }) });
		next = new CloudMemberMachineScreenSignIn();
		expect((await ask()).status).toBe(401);
		next = new CloudMemberMachineScreenForbidden();
		expect((await ask()).status).toBe(403);
		next = new Error("typed hunter2 for Bearer eyJ");
		const failed = await ask();
		expect(failed.status).toBe(503);
		expect(failed.body).not.toContain("hunter2");
		expect(s.failed).toHaveBeenLastCalledWith("UNCLASSIFIED");
		expect(JSON.stringify(s.failed.mock.calls)).not.toContain("hunter2");
	});
});

describe("a member's look begun as the member (deploy/coding-worker/member-control.ts)", () => {
	function control(status: number, body: unknown) {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
		);
		return {
			fetcher,
			control: new MemberMachineScreenControl({
				supabaseUrl: "https://project.supabase.co",
				publishableKey: "sb_publishable_xn-Yy0QJ5iGEFmsiJGmw7w_JMsDTo8N",
				fetch: fetcher,
			}),
		};
	}
	const look = { companyId: randomUUID(), machineId: randomUUID(), confirmed: true };
	const signal = new AbortController().signal;

	it("calls the begin as the member: the member's token, the publishable key, one fixed function", async () => {
		const useId = randomUUID();
		const c = control(200, { schema: "qorpera.member-machine-screen/v1", state: "ok", useId });
		expect(await c.control.begin(token, look, signal)).toBe(useId);
		const [url, init] = c.fetcher.mock.calls[0]!;
		expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_screen_begin");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: {
				apikey: "sb_publishable_xn-Yy0QJ5iGEFmsiJGmw7w_JMsDTo8N",
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			p_profile_id: look.companyId,
			p_machine_id: look.machineId,
			p_watch: { confirmed: true },
		});
	});

	it("turns the begin's refusals into the member's, and never puts the token in an error", async () => {
		for (const reason of ["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW", "SCREEN_TOO_SOON"]) {
			const c = control(200, { schema: "qorpera.member-machine-screen/v1", state: "refused", reason });
			await expect(c.control.begin(token, look, signal)).rejects.toMatchObject({ code: reason });
		}
		const cases: [
			number,
			unknown,
			string | typeof CloudMemberMachineScreenSignIn | typeof CloudMemberMachineScreenForbidden,
		][] = [
			[401, { message: "JWT expired" }, CloudMemberMachineScreenSignIn],
			[403, { code: "42501" }, CloudMemberMachineScreenForbidden],
			[400, { code: "22023" }, "MEMBER_SCREEN_BEGIN_UNCONFIRMED"],
			[500, "", "MEMBER_SCREEN_BEGIN_UNCONFIRMED"],
			[200, "not json", "MEMBER_SCREEN_BEGIN_UNCONFIRMED"],
			[
				200,
				{ schema: "qorpera.member-machine-screen/v1", state: "refused", reason: "SOMETHING" },
				"MEMBER_SCREEN_BEGIN_INVALID",
			],
			[
				200,
				{ schema: "qorpera.member-machine-screen/v1", state: "ok", useId: "use" },
				"MEMBER_SCREEN_BEGIN_INVALID",
			],
			[
				200,
				{ schema: "qorpera.member-machine-screen/v1", state: "ok", useId: randomUUID(), placementId: randomUUID() },
				"MEMBER_SCREEN_BEGIN_INVALID",
			],
		];
		for (const [status, body, expected] of cases) {
			const c = control(status, body);
			const error = await c.control.begin(token, look, signal).catch((caught: unknown) => caught);
			if (typeof expected === "string") expect(error, JSON.stringify(body)).toMatchObject({ message: expected });
			else expect(error).toBeInstanceOf(expected);
			expect(String((error as Error).message)).not.toContain(token);
		}
		// A token of another shape is never sent.
		const c = control(200, {});
		await expect(c.control.begin("a b", look, signal)).rejects.toBeInstanceOf(CloudMemberMachineScreenSignIn);
		await expect(c.control.begin(token, { ...look, machineId: "machine" }, signal)).rejects.toThrow(
			"MEMBER_SCREEN_BEGIN_INVALID",
		);
		expect(c.fetcher).not.toHaveBeenCalled();
		expect(
			() =>
				new MemberMachineScreenControl({
					supabaseUrl: "http://project.supabase.co",
					publishableKey: "sb_publishable_x",
				}),
		).toThrow("MEMBER_SCREEN_CONTROL_CONFIG_INVALID");
	});
});

describe("a member's action begun as the member (deploy/coding-worker/member-control.ts, 20260930713000)", () => {
	function control(status: number, body: unknown) {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
		);
		return {
			fetcher,
			control: new MemberMachineScreenControl({
				supabaseUrl: "https://project.supabase.co",
				publishableKey: "sb_publishable_xn-Yy0QJ5iGEFmsiJGmw7w_JMsDTo8N",
				fetch: fetcher,
			}),
		};
	}
	const act = {
		companyId: randomUUID(),
		machineId: randomUUID(),
		action: { type: "type", text: "hunter2 Åse" } as const,
		epoch: 3,
	};
	const signal = new AbortController().signal;

	it("calls the action's begin as the member with the text's length alone", async () => {
		const actionId = randomUUID();
		const c = control(200, { schema: "qorpera.member-machine-desktop-act/v1", state: "ok", actionId });
		expect(await c.control.act(token, act, signal)).toBe(actionId);
		const [url, init] = c.fetcher.mock.calls[0]!;
		expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_desktop_act_begin");
		expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}` } });
		expect(JSON.parse(String(init?.body))).toEqual({
			p_profile_id: act.companyId,
			p_machine_id: act.machineId,
			p_action: { type: "type", length: 11 },
			p_epoch: 3,
		});
		expect(String(init?.body)).not.toContain("hunter2");
	});

	it("turns the begin's refusals into the member's, and fails closed on anything else", async () => {
		for (const reason of [
			"MACHINE_NOT_RUNNING",
			"MACHINE_NEEDS_COMPANY_VIEW",
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_CONTROL_ENDED",
		]) {
			const c = control(200, { schema: "qorpera.member-machine-desktop-act/v1", state: "refused", reason });
			const error = await c.control.act(token, act, signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachineActRefusal);
			expect(error).toMatchObject({ code: reason });
		}
		await expect(
			control(200, {
				schema: "qorpera.member-machine-desktop-act/v1",
				state: "refused",
				reason: "SCREEN_TOO_SOON",
			}).control.act(token, act, signal),
		).rejects.toThrow("MEMBER_ACT_BEGIN_INVALID");
		await expect(control(401, {}).control.act(token, act, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenSignIn,
		);
		await expect(control(403, {}).control.act(token, act, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenForbidden,
		);
		await expect(control(400, {}).control.act(token, act, signal)).rejects.toThrow("MEMBER_ACT_BEGIN_UNCONFIRMED");
		const opened = control(200, {});
		await expect(
			opened.control.act(token, { ...act, action: { type: "open", target: "https://x.test" } } as never, signal),
		).rejects.toThrow("MEMBER_ACT_BEGIN_INVALID");
		// An epoch that is not a safe whole number, 0 or more, is never sent (F24).
		for (const epoch of [-1, 1.5, Number.NaN, 2 ** 53])
			await expect(opened.control.act(token, { ...act, epoch }, signal)).rejects.toThrow("MEMBER_ACT_BEGIN_INVALID");
		expect(opened.fetcher).not.toHaveBeenCalled();
		// The begin of a look now hears another member's hold too.
		const look = control(200, {
			schema: "qorpera.member-machine-screen/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		});
		await expect(
			look.control.begin(token, { companyId: act.companyId, machineId: act.machineId, confirmed: true }, signal),
		).rejects.toMatchObject({ code: "DESKTOP_MEMBER_IN_CONTROL" });
	});
});
