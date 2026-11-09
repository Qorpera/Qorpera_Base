// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyInterfacePages, type InterfacePagesState } from "../src/app/interface-pages.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type InterfacePageCalls,
	interfacePageCalls,
	type MemberInterfacePages,
	parseInterfacePages,
} from "../src/cloud/interface-pages.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { deferred, settle } from "./fixtures.ts";

/* Interfaces C6a (supabase/CLIENT-CONTRACT.md "Pages"): which of its two pages a company shows, as the web reads it
 * (cloud/interface-pages.ts) and follows it while the company is open (app/interface-pages.ts); an owner or admin hides or
 * shows one from the rail (views/shell.ts). */

const answer = (mailbox: boolean, members: boolean, mayChange = true) => ({
	schema: "qorpera.member-interface-pages/v1",
	pages: [
		{ page: "mailbox", on: mailbox },
		{ page: "members", on: members },
	],
	mayChange,
});
const state = (mailbox: boolean, members: boolean, mayChange = true): MemberInterfacePages =>
	parseInterfacePages(answer(mailbox, members, mayChange));
const missing = () =>
	new CloudRpcError("qorpera_member_interface_pages", { message: "missing", code: "PGRST202" }, 404);
const denied = () =>
	new CloudRpcError("qorpera_member_interface_pages", { message: "Not a member.", code: "42501" }, 403);

const cleanup: (() => void)[] = [];
beforeEach(() => {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	Reflect.deleteProperty(document, "visibilityState");
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the pages answer (cloud/interface-pages.ts)", () => {
	it("reads both pages in their order, and whether the member may switch them", () => {
		expect(parseInterfacePages(answer(false, true, false))).toEqual({
			pages: [
				{ page: "mailbox", on: false },
				{ page: "members", on: true },
			],
			mayChange: false,
		});
	});

	it("refuses another schema, a page it doesn't know, a page twice, or a switch that isn't on or off", () => {
		const bad = [
			null,
			{ ...answer(true, true), schema: "qorpera.member-interface-pages/v2" },
			{ ...answer(true, true), mayChange: "yes" },
			{ ...answer(true, true), pages: null },
			{ ...answer(true, true), pages: [{ page: "pulse", on: true }] },
			{
				...answer(true, true),
				pages: [
					{ page: "members", on: true },
					{ page: "members", on: false },
				],
			},
			{ ...answer(true, true), pages: [{ page: "members", on: "true" }] },
		];
		for (const value of bad) expect(() => parseInterfacePages(value)).toThrow(CloudShapeError);
	});

	it("reads and switches the pages of one company", async () => {
		const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) => answer(true, false));
		const calls = interfacePageCalls({ rpc } as unknown as Cloud, "environment-1");
		await expect(calls.list()).resolves.toEqual(state(true, false));
		await expect(calls.set("members", true)).resolves.toEqual(state(true, false));
		expect(rpc.mock.calls).toEqual([
			["qorpera_member_interface_pages", { p_environment_id: "environment-1" }],
			["qorpera_set_interface_page", { p_environment_id: "environment-1", p_page: "members", p_on: true }],
		]);
	});
});

describe("following the pages (app/interface-pages.ts)", () => {
	function follow(list: InterfacePageCalls["list"]) {
		const published: (InterfacePagesState | undefined)[] = [];
		const stop = new AbortController();
		const pages = new CompanyInterfacePages({ list, set: vi.fn() }, (next) => published.push(next), stop.signal);
		cleanup.push(() => stop.abort());
		return { pages, published, stop };
	}

	it("reads on opening, on coming back and each minute, and publishes each change once", async () => {
		vi.useFakeTimers();
		let now = state(false, true);
		const list = vi.fn(async () => now);
		const { pages, published } = follow(list);
		pages.open();
		await settle();
		expect(published).toEqual([state(false, true)]);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(list).toHaveBeenCalledTimes(2);
		expect(published).toHaveLength(1);
		now = state(true, true);
		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		expect(list).toHaveBeenCalledTimes(3);
		expect(published).toEqual([state(false, true), state(true, true)]);
	});

	it("shows no page on a cloud without the call or for a member it doesn't answer, and keeps the last read otherwise", async () => {
		const list = vi.fn<InterfacePageCalls["list"]>().mockResolvedValueOnce(state(true, true));
		const { pages, published } = follow(list);
		await pages.refresh();
		list.mockRejectedValueOnce(new Error("Network unavailable"));
		await pages.refresh();
		list.mockRejectedValueOnce(
			new CloudRpcError("qorpera_member_interface_pages", { message: "busy", code: "XX000" }, 500),
		);
		await pages.refresh();
		list.mockRejectedValueOnce(new CloudShapeError("pages"));
		await pages.refresh();
		expect(published).toEqual([state(true, true)]);
		list.mockRejectedValueOnce(denied());
		await pages.refresh();
		expect(published).toEqual([state(true, true), undefined]);
		list.mockResolvedValueOnce(state(true, true));
		await pages.refresh();
		list.mockRejectedValueOnce(missing());
		await pages.refresh();
		expect(published).toEqual([state(true, true), undefined, state(true, true), undefined]);
	});

	it("reads once more for all the calls made during a read, and publishes nothing once stopped", async () => {
		const first = deferred<MemberInterfacePages>();
		const list = vi
			.fn<InterfacePageCalls["list"]>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(state(true, false));
		const { pages, published, stop } = follow(list);
		const reading = pages.refresh();
		const again = [pages.refresh(), pages.refresh(), pages.refresh()];
		expect(again[0]).toBe(again[2]);
		first.resolve(state(false, false));
		await Promise.all([reading, ...again]);
		expect(list).toHaveBeenCalledTimes(2);
		expect(published).toEqual([state(false, false), state(true, false)]);
		// A read answered after the company closed publishes nothing, and nothing reads again.
		const late = deferred<MemberInterfacePages>();
		list.mockReturnValueOnce(late.promise);
		const last = pages.refresh();
		stop.abort();
		late.resolve(state(true, true));
		await last;
		await pages.refresh();
		pages.open();
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(list).toHaveBeenCalledTimes(3);
		expect(published).toHaveLength(2);
	});
});

describe("hiding and showing a page (app/interface-pages.ts set)", () => {
	function follow(calls: InterfacePageCalls) {
		const published: (InterfacePagesState | undefined)[] = [];
		const stop = new AbortController();
		const pages = new CompanyInterfacePages(calls, (next) => published.push(next), stop.signal);
		cleanup.push(() => stop.abort());
		return { pages, published };
	}

	it("publishes the change's answer at once, and drops a read the change overtook", async () => {
		const before = deferred<MemberInterfacePages>();
		const list = vi.fn<InterfacePageCalls["list"]>().mockReturnValueOnce(before.promise);
		const set = vi.fn<InterfacePageCalls["set"]>(async () => state(false, true));
		const { pages, published } = follow({ list, set });
		const reading = pages.refresh();
		await pages.set("mailbox", false);
		expect(set).toHaveBeenCalledExactlyOnceWith("mailbox", false);
		expect(published).toEqual([state(false, true)]);
		before.resolve(state(true, true));
		await reading;
		expect(published).toEqual([state(false, true)]);
	});

	it("reads the pages again when a change fails, and says so", async () => {
		const list = vi.fn<InterfacePageCalls["list"]>(async () => state(true, false));
		const set = vi.fn<InterfacePageCalls["set"]>(async () => {
			throw new Error("Network unavailable");
		});
		const { pages, published } = follow({ list, set });
		await expect(pages.set("members", true)).rejects.toThrow("Network unavailable");
		expect(list).toHaveBeenCalledOnce();
		expect(published).toEqual([state(true, false)]);
	});
});
