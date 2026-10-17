// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyInterfacePages, type InterfacePagesState } from "../src/app/interface-pages.ts";
import { PagesView } from "../src/app/views/settings-pages.ts";
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
 * (cloud/interface-pages.ts), follows it while the company is open (app/interface-pages.ts), and lets an owner or admin
 * switch it in Settings → Company (views/settings-pages.ts). */

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

describe("Settings → Company → Pages (views/settings-pages.ts)", () => {
	/** The view on screen, reading `initial` from the cloud, or failing with `failure`. A null `role` is one not read
	 * yet. */
	function setup(initial: MemberInterfacePages, role: string | null = "owner", failure?: Error) {
		const cloud: { pages: MemberInterfacePages; failure?: Error } = { pages: initial, failure };
		const member: { role: string | undefined } = { role: role ?? undefined };
		const calls = {
			list: vi.fn<InterfacePageCalls["list"]>(async () => {
				if (cloud.failure) throw cloud.failure;
				return cloud.pages;
			}),
			set: vi.fn<InterfacePageCalls["set"]>(async (page, on) => {
				const pages = cloud.pages.pages.map((entry) => (entry.page === page ? { page, on } : entry));
				cloud.pages = { ...cloud.pages, pages };
				return cloud.pages;
			}),
		};
		const changed = vi.fn();
		const stop = new AbortController();
		const view = new PagesView(calls, stop.signal, () => member.role, changed);
		document.body.append(view.el);
		cleanup.push(() => stop.abort());
		const switches = () => [...view.el.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
		const checked = () => switches().map((lever) => lever.getAttribute("aria-checked"));
		const help = () => view.el.querySelector(".settings-help")?.textContent;
		return { view, calls, changed, cloud, member, switches, checked, help };
	}

	it("lets an owner switch a page on and off, keeping the keyboard on the switch", async () => {
		const f = setup(state(false, true));
		expect(f.help()).toBe("Loading…");
		await settle();
		expect(f.switches().map((lever) => lever.getAttribute("aria-label"))).toEqual(["Mailbox", "Members"]);
		expect(f.checked()).toEqual(["false", "true"]);
		expect(f.switches().some((lever) => lever.hasAttribute("aria-disabled"))).toBe(false);
		expect(f.help()).toBe("Switching a page off only hides it. Nothing it showed is removed.");
		const sent = deferred<MemberInterfacePages>();
		f.calls.set.mockReturnValueOnce(sent.promise);
		f.switches()[0]!.focus();
		f.switches()[0]!.click();
		expect(f.calls.set).toHaveBeenCalledWith("mailbox", true);
		// While it is sent, the other switch waits, and a second press sends nothing.
		expect(f.switches().map((lever) => lever.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
		expect(f.switches()[0]!.getAttribute("aria-busy")).toBe("true");
		f.switches()[0]!.click();
		f.switches()[1]!.click();
		expect(f.calls.set).toHaveBeenCalledOnce();
		f.cloud.pages = state(true, true);
		sent.resolve(f.cloud.pages);
		await settle();
		expect(f.checked()).toEqual(["true", "true"]);
		expect(f.switches()[0]!.hasAttribute("aria-busy")).toBe(false);
		expect(document.activeElement).toBe(f.switches()[0]);
		expect(f.changed).toHaveBeenCalledOnce();
		f.switches()[1]!.click();
		await settle();
		expect(f.calls.set).toHaveBeenLastCalledWith("members", false);
		expect(f.checked()).toEqual(["true", "false"]);
		expect(f.changed).toHaveBeenCalledTimes(2);
	});

	it("shows anyone else the switches locked, and reads them again when the member's role changes", async () => {
		const f = setup(state(true, false, false), "contributor");
		await settle();
		expect(f.checked()).toEqual(["true", "false"]);
		expect(f.switches().map((lever) => lever.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
		expect(f.switches().every((lever) => lever.classList.contains("is-locked"))).toBe(true);
		expect(f.help()).toBe("Only owners and admins can switch pages on or off.");
		f.switches()[1]!.click();
		await settle();
		expect(f.calls.set).not.toHaveBeenCalled();
		expect(f.changed).not.toHaveBeenCalled();
		// The same role reads nothing again; a new one does.
		f.view.update();
		expect(f.calls.list).toHaveBeenCalledOnce();
		f.member.role = "admin";
		f.cloud.pages = state(true, false);
		f.view.update();
		await settle();
		expect(f.calls.list).toHaveBeenCalledTimes(2);
		expect(f.switches().some((lever) => lever.classList.contains("is-locked"))).toBe(false);
		f.switches()[1]!.click();
		await settle();
		expect(f.calls.set).toHaveBeenCalledWith("members", true);
	});

	it("reads nothing more when the member's role first arrives or is gone a moment: the cloud answered for it", async () => {
		// The team isn't read yet, so the pages are read without a role.
		const f = setup(state(false, true), null);
		await settle();
		f.member.role = "owner";
		f.view.update();
		f.member.role = undefined;
		f.view.update();
		f.member.role = "owner";
		f.view.update();
		await settle();
		expect(f.calls.list).toHaveBeenCalledOnce();
		f.member.role = "contributor";
		f.view.update();
		await settle();
		expect(f.calls.list).toHaveBeenCalledTimes(2);
	});

	it("says when a switch fails, reads the pages back first, and lets the member try again", async () => {
		const f = setup(state(false, true));
		await settle();
		f.calls.set.mockRejectedValueOnce(new Error("Network unavailable"));
		f.switches()[1]!.click();
		await settle();
		// A change that failed may still have landed: the switches show what the cloud says.
		expect(f.calls.list).toHaveBeenCalledTimes(2);
		expect(f.checked()).toEqual(["false", "true"]);
		expect(f.view.el.querySelector(".notice-danger")?.textContent).toBe("Members could not be changed. Try again.");
		expect(f.changed).toHaveBeenCalledOnce();
		f.switches()[1]!.click();
		await settle();
		expect(f.checked()).toEqual(["false", "false"]);
		expect(f.view.el.querySelector(".notice-danger")).toBeNull();
	});

	it("says why the pages can't be read, and that a cloud without them has none yet", async () => {
		const f = setup(state(false, false), "owner", new Error("Network unavailable"));
		await settle();
		expect(f.view.el.querySelector(".notice-danger")?.textContent).toBe("Network unavailable");
		expect(f.switches()).toEqual([]);
		expect(f.help()).toBeUndefined();
		// Read again once the role changes, the switches show.
		f.cloud.failure = undefined;
		f.member.role = "admin";
		f.view.update();
		await settle();
		expect(f.checked()).toEqual(["false", "false"]);
		expect(f.view.el.querySelector(".notice-danger")).toBeNull();
		const other = setup(state(false, false), "owner", missing());
		await settle();
		expect(other.view.el.querySelector(".notice-neutral")?.textContent).toBe(
			"Pages are not available on this cloud yet.",
		);
		expect(other.switches()).toEqual([]);
		// It doesn't ask again.
		other.member.role = "admin";
		other.view.update();
		await settle();
		expect(other.calls.list).toHaveBeenCalledOnce();
	});
});
