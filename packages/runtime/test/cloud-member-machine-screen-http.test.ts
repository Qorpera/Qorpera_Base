import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberMachineScreenControl } from "../../../deploy/coding-worker/member-control.ts";
import { CloudMemberMachineScreenRefusal } from "../src/cloud-machine-command-http.ts";
import {
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

async function service(look: (request: CloudMemberMachineScreenLook) => Promise<{ etag: string; png: Buffer | null }>) {
	const failed = vi.fn();
	const looked = vi.fn(look);
	const http = new HttpCloudMemberMachineScreenService({ look: looked, failed });
	const port = await http.start();
	cleanups.push(() => http.close());
	const companyId = randomUUID();
	const machineId = randomUUID();
	const url = (suffix = "") => `http://127.0.0.1:${port}/v1/member-machine-screens/${companyId}/${machineId}${suffix}`;
	return { looked, failed, url, companyId, machineId, port };
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
