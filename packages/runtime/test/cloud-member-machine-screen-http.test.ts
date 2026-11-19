import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberMachineScreenControl } from "../../../deploy/coding-worker/member-control.ts";
import {
	CloudMemberMachineActRefusal,
	CloudMemberMachinePointerRefusal,
	CloudMemberMachineScreenRefusal,
	CloudMemberMachineStartRefusal,
} from "../src/cloud-machine-command-http.ts";
import {
	type CloudMemberMachineActRequest,
	type CloudMemberMachinePointerAnswer,
	type CloudMemberMachinePointerRequest,
	CloudMemberMachineScreenForbidden,
	type CloudMemberMachineScreenLook,
	CloudMemberMachineScreenSignIn,
	type CloudMemberMachineStartRequest,
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
	start?: (request: CloudMemberMachineStartRequest) => Promise<{ outcome: "started" | "running" | "opened" }>,
	pointer?: (request: CloudMemberMachinePointerRequest) => Promise<CloudMemberMachinePointerAnswer>,
) {
	const failed = vi.fn();
	const looked = vi.fn(look);
	const acted = vi.fn(act ?? (async () => ({ exitCode: 0 })));
	const started = vi.fn(start ?? (async () => ({ outcome: "started" as const })));
	const pointed = vi.fn(pointer ?? (async () => ({ moved: true })));
	const http = new HttpCloudMemberMachineScreenService({
		look: looked,
		failed,
		...(act ? { act: acted } : {}),
		...(start ? { start: started } : {}),
		...(pointer ? { pointer: pointed } : {}),
	});
	const port = await http.start();
	cleanups.push(() => http.close());
	const companyId = randomUUID();
	const machineId = randomUUID();
	const url = (suffix = "") => `http://127.0.0.1:${port}/v1/member-machine-screens/${companyId}/${machineId}${suffix}`;
	return { looked, acted, started, pointed, failed, url, companyId, machineId, port };
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
		const done = await post(s.url("/act"), { action: { type: "type", text: "hunter2 Åse" }, epoch: 3, seat: 11 });
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
				seat: 11,
			},
			expect.any(AbortSignal),
		);
		// The epoch and the seat of the hold the input was captured under go on as they came (F24, F26), 0 too.
		await post(s.url("/act"), { seat: 0, epoch: 0, action: { type: "click", x: 812, y: 443, button: "right" } });
		expect(s.acted).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: { type: "click", x: 812, y: 443, button: "right" }, epoch: 0, seat: 0 }),
			expect.any(AbortSignal),
		);
		expect(s.looked).not.toHaveBeenCalled();
	});

	it("passes the action alone as a shared one (20260930734000), its text with it, and never an epoch or a seat", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			async () => ({ exitCode: 0 }),
		);
		const done = await post(s.url("/act"), { action: { type: "type", text: "hunter2 Åse" } });
		expect(done.status).toBe(200);
		expect(await done.json()).toEqual({ schema: "qorpera.member-machine-act/v1", exitCode: 0 });
		expect(s.acted).toHaveBeenLastCalledWith(
			{
				companyId: s.companyId,
				machineId: s.machineId,
				token,
				action: { type: "type", text: "hunter2 Åse" },
				shared: true,
			},
			expect.any(AbortSignal),
		);
		await post(s.url("/act"), { action: { type: "scroll", direction: "down", steps: 2, x: 4, y: 5 } });
		expect(s.acted).toHaveBeenLastCalledWith(
			{
				companyId: s.companyId,
				machineId: s.machineId,
				token,
				action: { type: "scroll", direction: "down", steps: 2, x: 4, y: 5 },
				shared: true,
			},
			expect.any(AbortSignal),
		);
		// A shared action is the action alone: a `shared` word, half a hold, or a hold with it are bad requests.
		for (const body of [
			{ action: { type: "click", x: 1, y: 2 }, shared: true },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1 },
			{ action: { type: "click", x: 1, y: 2 }, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1, shared: true },
			{ action: { type: "open", target: "https://bank.example.test" } },
			{ action: { type: "type", text: "x".repeat(501) } },
			{ action: null },
		]) {
			const response = await post(s.url("/act"), body);
			expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
			expect(await response.text()).not.toContain("hunter2");
		}
		expect(s.acted).toHaveBeenCalledTimes(2);
	});

	it("passes the lease generation a shared action was made under (20260930738000), and nothing else beside it", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			async () => ({ exitCode: 0 }),
		);
		const done = await post(s.url("/act"), { generation: 7, action: { type: "type", text: "hunter2" } });
		expect(done.status).toBe(200);
		expect(s.acted).toHaveBeenLastCalledWith(
			{
				companyId: s.companyId,
				machineId: s.machineId,
				token,
				action: { type: "type", text: "hunter2" },
				shared: true,
				generation: 7,
			},
			expect.any(AbortSignal),
		);
		await post(s.url("/act"), { action: { type: "click", x: 1, y: 2 }, generation: 0 });
		expect(s.acted).toHaveBeenLastCalledWith(
			expect.objectContaining({ shared: true, generation: 0 }),
			expect.any(AbortSignal),
		);
		// A generation is a safe whole number, 0 or more, and never beside a hold.
		for (const generation of [-1, 1.5, 2 ** 53, "3", null, true])
			expect(
				(await post(s.url("/act"), { action: { type: "click", x: 1, y: 2 }, generation })).status,
				String(generation),
			).toBe(400);
		for (const body of [
			{ action: { type: "click", x: 1, y: 2 }, generation: 1, epoch: 1, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, generation: 1, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, generation: 1, shared: true },
			{ generation: 1 },
		])
			expect((await post(s.url("/act"), body)).status, JSON.stringify(body)).toBe(400);
		expect(s.acted).toHaveBeenCalledTimes(2);
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
			{ action: { type: "open", target: "https://bank.example.test" }, epoch: 1, seat: 1 },
			{ action: { type: "type", text: "hunter2" }, epoch: 1, seat: 1 },
			{ action: { type: "type", text: "x".repeat(501) }, epoch: 1, seat: 1 },
			{ action: { type: "key", keys: ["exec", "id"] }, epoch: 1, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1, intent: "x" },
			{ act: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1 },
			// The epoch is never guessed (F24): missing, below 0, not whole, too large, or not a number.
			{ action: { type: "click", x: 1, y: 2 }, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: -1, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1.5, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 2 ** 53, seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: "1", seat: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: null, seat: 1 },
			// Nor is the seat (F26).
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: -1 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 2.5 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 2 ** 53 },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: "2" },
			{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: null },
			[{ type: "click", x: 1, y: 2 }],
			"not json hunter2",
			JSON.stringify({ action: { type: "type", text: "y".repeat(400) }, epoch: 1, seat: 1, pad: "z".repeat(17000) }),
		])
			expect(await status(post(s.url("/act"), body)), JSON.stringify(body).slice(0, 80)).toBe(400);
		expect(
			await status(
				post(
					s.url("/act"),
					{ action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1 },
					{ "content-type": "text/plain" },
				),
			),
		).toBe(400);
		expect(s.acted).not.toHaveBeenCalled();
		// The look's routes take no POST; the action's takes no GET; and no token, no action.
		expect(await status(fetch(s.url("/act"), { headers: { authorization: `Bearer ${token}` } }))).toBe(405);
		expect(await status(post(s.url("/watching"), { action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1 }))).toBe(
			405,
		);
		expect(
			await status(
				fetch(s.url("/act"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: { type: "type", text: "hunter2" }, epoch: 1, seat: 1 }),
				}),
			),
		).toBe(401);
		expect(s.acted).not.toHaveBeenCalled();
		// A listener without actions has no such route.
		const looksOnly = await service(async () => ({ etag, png: picture }));
		expect(
			await status(post(looksOnly.url("/act"), { action: { type: "click", x: 1, y: 2 }, epoch: 1, seat: 1 })),
		).toBe(404);
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
			const response = await post(s.url("/act"), { action: { type: "type", text: "hunter2" }, epoch: 1, seat: 1 });
			return { status: response.status, body: await response.text() };
		};
		next = new CloudMemberMachineActRefusal("DESKTOP_CONTROL_ENDED");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "DESKTOP_CONTROL_ENDED" }) });
		// Someone held the desktop privately since a shared input was made (20260930738000).
		next = new CloudMemberMachineActRefusal("DESKTOP_HELD_SINCE");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "DESKTOP_HELD_SINCE" }) });
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

describe("a member's pointer through the executor's member listener (20260930744000)", () => {
	const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	const pass = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a00";

	it("passes a pass's begin (shared or private) and a move on, with the member's token, and answers only the pass or whether it moved", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			undefined,
			async (request) => ("begin" in request ? { pass, milliseconds: 10000 } : { moved: true }),
		);
		const begun = await post(s.url("/pointer"), { begin: { generation: 7 } });
		expect(begun.status).toBe(200);
		expect(await begun.json()).toEqual({ schema: "qorpera.member-machine-pointer/v1", pass, milliseconds: 10000 });
		expect(s.pointed).toHaveBeenLastCalledWith(
			{ companyId: s.companyId, machineId: s.machineId, token, begin: { generation: 7 } },
			expect.any(AbortSignal),
		);
		await post(s.url("/pointer"), { begin: { seat: 3, epoch: 0 } });
		expect(s.pointed).toHaveBeenLastCalledWith(
			expect.objectContaining({ begin: { epoch: 0, seat: 3 } }),
			expect.any(AbortSignal),
		);
		const moved = await post(s.url("/pointer"), { pass, x: 3839, y: 0 });
		expect(moved.status).toBe(200);
		expect(await moved.json()).toEqual({ schema: "qorpera.member-machine-pointer/v1", moved: true });
		expect(s.pointed).toHaveBeenLastCalledWith(
			{ companyId: s.companyId, machineId: s.machineId, token, pass, x: 3839, y: 0 },
			expect.any(AbortSignal),
		);
		expect(s.looked).not.toHaveBeenCalled();
	});

	it("sells a live picture's ticket on a pass and its hold, for the browser's Origin the member bridge passed on, and refuses one without it (20260930745000)", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			undefined,
			async () => ({ ticket: "T".repeat(43), seconds: 30 }),
		);
		const sold = await post(
			s.url("/pointer"),
			{ stream: { pass, hold: { generation: 7 } } },
			{ origin: "https://app.qorpera.com" },
		);
		expect(sold.status).toBe(200);
		expect(await sold.json()).toEqual({
			schema: "qorpera.member-machine-pointer/v1",
			ticket: "T".repeat(43),
			seconds: 30,
		});
		expect(s.pointed).toHaveBeenLastCalledWith(
			{
				companyId: s.companyId,
				machineId: s.machineId,
				token,
				stream: { pass, hold: { generation: 7 } },
				origin: "https://app.qorpera.com",
			},
			expect.any(AbortSignal),
		);
		await post(
			s.url("/pointer"),
			{ stream: { pass, hold: { seat: 3, epoch: 1 } } },
			{ origin: "https://app.qorpera.com" },
		);
		expect(s.pointed).toHaveBeenLastCalledWith(
			expect.objectContaining({ stream: { pass, hold: { epoch: 1, seat: 3 } } }),
			expect.any(AbortSignal),
		);
		const calls = s.pointed.mock.calls.length;
		for (const [body, origin] of [
			[{ stream: { pass, hold: { generation: 7 } } }, undefined],
			[{ stream: { pass, hold: { generation: 7 } } }, "null"],
			[{ stream: { pass, hold: { generation: 7 } } }, "http://evil.example"],
			[{ stream: { pass, hold: { generation: 7 }, x: 1 } }, "https://app.qorpera.com"],
			[{ stream: { pass } }, "https://app.qorpera.com"],
			[{ stream: { pass, hold: { epoch: 1 } } }, "https://app.qorpera.com"],
			[{ stream: { pass: "pass", hold: { generation: 7 } } }, "https://app.qorpera.com"],
			[{ stream: { pass, hold: { generation: 7 } }, x: 1 }, "https://app.qorpera.com"],
		] as const)
			expect(
				(await post(s.url("/pointer"), body, origin ? { origin } : {})).status,
				`${JSON.stringify(body)} ${origin}`,
			).toBe(400);
		expect(s.pointed.mock.calls.length).toBe(calls);
	});

	it("refuses a body that is not a begin or a move as 400, and without the route it is 404", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			undefined,
			async () => ({ moved: true }),
		);
		for (const body of [
			{ begin: {} },
			{ begin: { generation: -1 } },
			{ begin: { generation: 1, epoch: 1, seat: 1 } },
			{ begin: { epoch: 1 } },
			{ begin: { epoch: 1, seat: 1.5 } },
			{ begin: { generation: "1" } },
			{ pass, x: 3840, y: 1 },
			{ pass, x: 1, y: 2160 },
			{ pass, x: -1, y: 1 },
			{ pass, x: 1.5, y: 1 },
			{ pass: "pass", x: 1, y: 1 },
			{ pass, x: 1, y: 1, text: "hunter2" },
			{ pass, x: 1 },
			[1, 2],
			"not json",
			JSON.stringify({ pass, x: 1, y: 1, pad: "z".repeat(300) }),
		])
			expect((await post(s.url("/pointer"), body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
		expect((await post(s.url("/pointer"), { pass, x: 1, y: 1 }, { "content-type": "text/plain" })).status).toBe(400);
		expect((await fetch(s.url("/pointer"), { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
		expect(s.pointed).not.toHaveBeenCalled();
		const without = await service(async () => ({ etag, png: picture }));
		expect((await post(without.url("/pointer"), { pass, x: 1, y: 1 })).status).toBe(404);
	});

	it("tells refusals by code and logs nothing of a move, not even its failure", async () => {
		let next: unknown;
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			undefined,
			async () => {
				throw next;
			},
		);
		const ask = async () => {
			const response = await post(s.url("/pointer"), { pass, x: 1, y: 2 });
			return { status: response.status, body: await response.text() };
		};
		next = new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "POINTER_PASS_ENDED" }) });
		next = new CloudMemberMachinePointerRefusal("DESKTOP_HELD_SINCE");
		expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code: "DESKTOP_HELD_SINCE" }) });
		next = new CloudMemberMachineScreenSignIn();
		expect((await ask()).status).toBe(401);
		next = new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		expect((await ask()).status).toBe(503);
		expect(s.failed).not.toHaveBeenCalled();
	});
});

describe("a member's start of the desktop through the executor's member listener (20260930714000)", () => {
	const post = (url: string, body: string, headers: Record<string, string> = {}) =>
		fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
			body,
		});
	it("passes the start and the member's token on, and answers whether the desktop started or ran", async () => {
		let outcome: "started" | "running" = "started";
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			async () => ({ outcome }),
		);
		const done = await post(s.url("/start"), "{}");
		expect(done.status).toBe(200);
		expect(done.headers.get("cache-control")).toBe("no-store");
		expect(await done.json()).toEqual({ schema: "qorpera.member-machine-start/v1", outcome: "started" });
		expect(s.started).toHaveBeenLastCalledWith(
			{ companyId: s.companyId, machineId: s.machineId, token },
			expect.any(AbortSignal),
		);
		outcome = "running";
		expect(await (await post(s.url("/start"), " { } ")).json()).toEqual({
			schema: "qorpera.member-machine-start/v1",
			outcome: "running",
		});
		expect(s.looked).not.toHaveBeenCalled();
	});
	it("passes what to open on whole, as one path, and answers that it opened (20260930758000)", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			async () => ({ outcome: "opened" }),
		);
		for (const open of [
			"apps/brooks-overblik",
			"Møder/æble og grød ø.md",
			"apps/a;b $(x) 'q'.txt",
			"x".repeat(500),
			"å".repeat(250),
		]) {
			const done = await post(s.url("/start"), JSON.stringify({ open }));
			expect(await done.json()).toEqual({ schema: "qorpera.member-machine-start/v1", outcome: "opened" });
			expect(s.started).toHaveBeenLastCalledWith(
				{ companyId: s.companyId, machineId: s.machineId, token, open },
				expect.any(AbortSignal),
			);
		}
	});
	it("refuses a body that is not `{}` as 400, by method and token first; without the route it is 404", async () => {
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			async () => ({ outcome: "started" }),
		);
		const status = async (response: Promise<Response>) => (await response).status;
		// Any key but `open`, an open that is no plain path of the company folder (20260930758000), or past the bounds.
		for (const body of [
			'{"open": "/company/apps/shop"}',
			'{"open": "apps/shop", "x": 1}',
			'{"pad": 1}',
			'{"open": 5}',
			'{"open": null}',
			'{"open": ""}',
			'{"open": "apps//shop"}',
			'{"open": "apps/../x"}',
			'{"open": "./apps"}',
			'{"open": "apps/"}',
			'{"open": "apps\\\\shop"}',
			'{"open": "a\\nb"}',
			'{"open": "a\\u0000b"}',
			'{"open": "a\\ud800b"}',
			`{"open": "${"x".repeat(501)}"}`,
			"[]",
			"null",
			'"x"',
			"",
			`{"pad":"${"p".repeat(1100)}"}`,
		])
			expect(await status(post(s.url("/start"), body)), body.slice(0, 40)).toBe(400);
		expect(await status(post(s.url("/start"), "{}", { "content-type": "text/plain" }))).toBe(400);
		expect(await status(fetch(s.url("/start"), { headers: { authorization: `Bearer ${token}` } }))).toBe(405);
		expect(
			await status(
				fetch(s.url("/start"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
			),
		).toBe(401);
		expect(s.started).not.toHaveBeenCalled();
		const looksOnly = await service(async () => ({ etag, png: picture }));
		expect(await status(post(looksOnly.url("/start"), "{}"))).toBe(404);
	});
	it("tells refusals by code, a token the database refused as 401, and logs only a fixed code", async () => {
		let next: unknown;
		const s = await service(
			async () => ({ etag, png: picture }),
			undefined,
			async () => {
				throw next;
			},
		);
		const ask = async () => {
			const response = await post(s.url("/start"), "{}");
			return { status: response.status, body: await response.text() };
		};
		for (const code of [
			"MACHINE_NOT_RUNNING",
			"DESKTOP_MACHINE_TOO_SMALL",
			"DESKTOP_START_TOO_SOON",
			"DESKTOP_DID_NOT_START",
			"DESKTOP_OPEN_PATH_INVALID",
			"DESKTOP_OPEN_NOT_FOUND",
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_OPEN_NO_FOLDER",
			"DESKTOP_DID_NOT_OPEN",
		] as const) {
			next = new CloudMemberMachineStartRefusal(code);
			expect(await ask()).toEqual({ status: 409, body: JSON.stringify({ code }) });
		}
		// Of these only the machine's failures are logged, by their codes: a desktop that did not start, a computer without
		// the company folder, an open that failed.
		expect(s.failed.mock.calls).toEqual([
			["DESKTOP_DID_NOT_START"],
			["DESKTOP_OPEN_NO_FOLDER"],
			["DESKTOP_DID_NOT_OPEN"],
		]);
		next = new CloudMemberMachineScreenSignIn();
		expect((await ask()).status).toBe(401);
		next = new Error("MEMBER_START_BEGIN_UNCONFIRMED");
		expect((await ask()).status).toBe(503);
		expect(s.failed).toHaveBeenLastCalledWith("MEMBER_START_BEGIN_UNCONFIRMED");
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
		seat: 11,
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
			p_seat: 11,
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
		// Nor is such a seat (F26).
		for (const seat of [-1, 1.5, Number.NaN, 2 ** 53])
			await expect(opened.control.act(token, { ...act, seat }, signal)).rejects.toThrow("MEMBER_ACT_BEGIN_INVALID");
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

describe("a member's shared action begun as the member (deploy/coding-worker/member-control.ts, 20260930734000)", () => {
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
	const share = {
		companyId: randomUUID(),
		machineId: randomUUID(),
		action: { type: "type", text: "hunter2 Åse" } as const,
	};
	const signal = new AbortController().signal;

	it("calls the shared begin as the member with the text's length alone, and no hold", async () => {
		const actionId = randomUUID();
		const c = control(200, { schema: "qorpera.member-machine-desktop-act/v1", state: "ok", actionId });
		expect(await c.control.share(token, share, signal)).toBe(actionId);
		const [url, init] = c.fetcher.mock.calls[0]!;
		expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_desktop_share_begin");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: { apikey: "sb_publishable_xn-Yy0QJ5iGEFmsiJGmw7w_JMsDTo8N", authorization: `Bearer ${token}` },
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			p_profile_id: share.companyId,
			p_machine_id: share.machineId,
			p_action: { type: "type", length: 11 },
		});
		expect(String(init?.body)).not.toContain("hunter2");
	});

	it("calls the begin that takes a generation with the one the input was made under (20260930738000), 0 too", async () => {
		for (const generation of [12, 0]) {
			const actionId = randomUUID();
			const c = control(200, { schema: "qorpera.member-machine-desktop-act/v1", state: "ok", actionId });
			expect(await c.control.share(token, { ...share, generation }, signal)).toBe(actionId);
			const [url, init] = c.fetcher.mock.calls[0]!;
			expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_desktop_share_begin");
			expect(JSON.parse(String(init?.body))).toEqual({
				p_profile_id: share.companyId,
				p_machine_id: share.machineId,
				p_action: { type: "type", length: 11 },
				p_generation: generation,
			});
		}
		// Never a generation that is not a safe whole number, 0 or more.
		const opened = control(200, {});
		for (const generation of [-1, 1.5, 2 ** 53, Number.NaN])
			await expect(
				opened.control.share(token, { ...share, generation }, signal),
				String(generation),
			).rejects.toThrow("MEMBER_SHARE_BEGIN_INVALID");
		expect(opened.fetcher).not.toHaveBeenCalled();
	});

	it("turns the shared begin's refusals into the member's, and fails closed on anything else", async () => {
		for (const reason of [
			"MACHINE_NOT_RUNNING",
			"MACHINE_NEEDS_COMPANY_VIEW",
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_MACHINE_TOO_SMALL",
			"DESKTOP_ACTIONS_TOO_FAST",
			"DESKTOP_HELD_SINCE",
		]) {
			const c = control(200, { schema: "qorpera.member-machine-desktop-act/v1", state: "refused", reason });
			const error = await c.control.share(token, share, signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachineActRefusal);
			expect(error).toMatchObject({ code: reason });
		}
		// A private hold's own word is not the shared begin's.
		for (const body of [
			{ schema: "qorpera.member-machine-desktop-act/v1", state: "refused", reason: "DESKTOP_CONTROL_ENDED" },
			{ schema: "qorpera.member-machine-desktop-act/v1", state: "ok", actionId: "action" },
			{ schema: "qorpera.member-machine-desktop-act/v1", state: "ok", actionId: randomUUID(), seat: 0 },
			{ schema: "qorpera.member-machine-desktop/v1", state: "ok", actionId: randomUUID() },
		])
			await expect(control(200, body).control.share(token, share, signal), JSON.stringify(body)).rejects.toThrow(
				"MEMBER_SHARE_BEGIN_INVALID",
			);
		await expect(control(401, {}).control.share(token, share, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenSignIn,
		);
		await expect(control(403, {}).control.share(token, share, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenForbidden,
		);
		const failed = await control(400, {})
			.control.share(token, share, signal)
			.catch((caught: unknown) => caught);
		expect(failed).toMatchObject({ message: "MEMBER_SHARE_BEGIN_UNCONFIRMED" });
		expect(String((failed as Error).message)).not.toContain(token);
		const opened = control(200, {});
		await expect(
			opened.control.share(token, { ...share, action: { type: "open", target: "https://x.test" } } as never, signal),
		).rejects.toThrow("MEMBER_SHARE_BEGIN_INVALID");
		await expect(opened.control.share(token, { ...share, machineId: "machine" }, signal)).rejects.toThrow(
			"MEMBER_SHARE_BEGIN_INVALID",
		);
		await expect(opened.control.share("a b", share, signal)).rejects.toBeInstanceOf(CloudMemberMachineScreenSignIn);
		expect(opened.fetcher).not.toHaveBeenCalled();
	});
});

describe("a member's pointer pass begun as the member (deploy/coding-worker/member-control.ts, 20260930744000)", () => {
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
	const where = { companyId: randomUUID(), machineId: randomUUID() };
	const signal = new AbortController().signal;

	it("calls the pass's begin as the member, shared at a generation or private at an epoch and seat, and answers its id", async () => {
		for (const [hold, args] of [
			[{ generation: 7 }, { p_generation: 7, p_epoch: null, p_seat: null }],
			[
				{ epoch: 0, seat: 3 },
				{ p_generation: null, p_epoch: 0, p_seat: 3 },
			],
		] as const) {
			const passId = randomUUID();
			const c = control(200, {
				schema: "qorpera.member-machine-desktop-pointer/v1",
				state: "ok",
				passId,
				seconds: 10,
			});
			expect(await c.control.pointer(token, { ...where, hold }, signal)).toBe(passId);
			const [url, init] = c.fetcher.mock.calls[0]!;
			expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_desktop_pointer_begin");
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				p_profile_id: where.companyId,
				p_machine_id: where.machineId,
				...args,
			});
		}
	});

	it("turns the begin's refusals into the member's, and fails closed on anything else", async () => {
		for (const reason of [
			"MACHINE_NOT_RUNNING",
			"MACHINE_NEEDS_COMPANY_VIEW",
			"DESKTOP_MACHINE_TOO_SMALL",
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_HELD_SINCE",
			"DESKTOP_CONTROL_ENDED",
		]) {
			const c = control(200, { schema: "qorpera.member-machine-desktop-pointer/v1", state: "refused", reason });
			const error = await c.control
				.pointer(token, { ...where, hold: { generation: 1 } }, signal)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachinePointerRefusal);
			expect(error).toMatchObject({ code: reason });
		}
		for (const body of [
			{ schema: "qorpera.member-machine-desktop-pointer/v1", state: "refused", reason: "DESKTOP_BUSY" },
			{ schema: "qorpera.member-machine-desktop-pointer/v1", state: "ok", passId: "pass", seconds: 10 },
			{ schema: "qorpera.member-machine-desktop-pointer/v1", state: "ok", passId: randomUUID(), seconds: 60 },
			{ schema: "qorpera.member-machine-desktop-act/v1", state: "ok", passId: randomUUID(), seconds: 10 },
		])
			await expect(
				control(200, body).control.pointer(token, { ...where, hold: { generation: 1 } }, signal),
				JSON.stringify(body),
			).rejects.toThrow("MEMBER_POINTER_BEGIN_INVALID");
		const opened = control(200, {});
		for (const hold of [
			{ generation: -1 },
			{ epoch: 1 },
			{ generation: 1, epoch: 1, seat: 1 },
			{ epoch: 1, seat: 1.5 },
		])
			await expect(
				opened.control.pointer(token, { ...where, hold } as never, signal),
				JSON.stringify(hold),
			).rejects.toThrow("MEMBER_POINTER_BEGIN_INVALID");
		await expect(opened.control.pointer("a b", { ...where, hold: { generation: 1 } }, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenSignIn,
		);
		expect(opened.fetcher).not.toHaveBeenCalled();
	});
});

describe("a member's start begun as the member (deploy/coding-worker/member-control.ts, 20260930714000)", () => {
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
	const start = { companyId: randomUUID(), machineId: randomUUID() };
	const signal = new AbortController().signal;
	const schema = "qorpera.member-machine-desktop-start/v1";

	it("calls the start's begin as the member, and answers its id", async () => {
		const startId = randomUUID();
		const c = control(200, { schema, state: "ok", startId });
		expect(await c.control.start(token, start, signal)).toEqual({ startId });
		const [url, init] = c.fetcher.mock.calls[0]!;
		expect(url).toBe("https://project.supabase.co/rest/v1/rpc/qorpera_member_machine_desktop_start_begin");
		expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}` } });
		expect(JSON.parse(String(init?.body))).toEqual({ p_profile_id: start.companyId, p_machine_id: start.machineId });
	});

	it("calls the begin that takes a path for a start that opens one, the path whole (20260930758000)", async () => {
		const startId = randomUUID();
		const c = control(200, { schema, state: "ok", startId });
		const open = "apps/a;b $(x) 'q'.txt";
		expect(await c.control.start(token, { ...start, open }, signal)).toEqual({ startId });
		expect(JSON.parse(String(c.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
			p_profile_id: start.companyId,
			p_machine_id: start.machineId,
			p_open: open,
		});
		for (const reason of ["DESKTOP_OPEN_PATH_INVALID", "DESKTOP_OPEN_NOT_FOUND", "DESKTOP_MEMBER_IN_CONTROL"]) {
			const error = await control(200, { schema, state: "refused", reason })
				.control.start(token, { ...start, open }, signal)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: reason });
		}
		// A path that is no plain path of the folder never reaches the database.
		const never = control(200, {});
		for (const bad of ["", "/apps", "a//b", "a/../b", "a\nb", "x".repeat(501)])
			await expect(never.control.start(token, { ...start, open: bad }, signal)).rejects.toThrow(
				"MEMBER_START_BEGIN_INVALID",
			);
		expect(never.fetcher).not.toHaveBeenCalled();
	});

	it("turns the begin's refusals into the member's, and fails closed on anything else", async () => {
		for (const reason of [
			"MACHINE_NOT_RUNNING",
			"MACHINE_NEEDS_COMPANY_VIEW",
			"DESKTOP_MACHINE_TOO_SMALL",
			"DESKTOP_START_TOO_SOON",
		]) {
			const error = await control(200, { schema, state: "refused", reason })
				.control.start(token, start, signal)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachineStartRefusal);
			expect(error).toMatchObject({ code: reason });
		}
		for (const body of [
			{ schema, state: "refused", reason: "DESKTOP_BUSY" },
			{ schema, state: "ok", startId: "x" },
			{ schema, state: "ok", startId: randomUUID(), more: 1 },
			{ schema: "qorpera.member-machine-desktop/v1", state: "held" },
		])
			await expect(control(200, body).control.start(token, start, signal), JSON.stringify(body)).rejects.toThrow(
				"MEMBER_START_BEGIN_INVALID",
			);
		await expect(control(401, {}).control.start(token, start, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenSignIn,
		);
		await expect(control(403, {}).control.start(token, start, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenForbidden,
		);
		const never = control(200, {});
		await expect(never.control.start(token, { ...start, machineId: "x" }, signal)).rejects.toThrow(
			"MEMBER_START_BEGIN_INVALID",
		);
		await expect(never.control.start("not a token", start, signal)).rejects.toBeInstanceOf(
			CloudMemberMachineScreenSignIn,
		);
		expect(never.fetcher).not.toHaveBeenCalled();
	});
});
