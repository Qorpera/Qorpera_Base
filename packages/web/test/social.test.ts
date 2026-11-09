// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchOnline } from "../src/app/online-mark.ts";
import { lastOnline } from "../src/app/views/friends.ts";
import { LeaderboardView } from "../src/app/views/leaderboard.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { CloudShapeError, parseFriends } from "../src/cloud/parse.ts";
import { type Leaderboard, parseLeaderboard } from "../src/cloud/social.ts";

const ME = "11111111-1111-4111-8111-000000000001";
const FRIEND = "11111111-1111-4111-8111-000000000002";
const OTHER = "11111111-1111-4111-8111-000000000005";
const COMPANY = "11111111-1111-4111-8111-000000000003";
const CAFE = "11111111-1111-4111-8111-000000000004";

function person(userId: string, name: string, tasks: number, revenueOre: number, extra: Record<string, unknown> = {}) {
	return {
		user_id: userId,
		display_name: name,
		me: userId === ME,
		last_seen_at: null,
		companies: 1,
		tasks,
		revenue_ore: revenueOre,
		...extra,
	};
}

const BOARD = {
	since: "2026-11-02T10:00:00Z",
	hidden: false,
	people: [
		person(ME, "Jonas", 12, 1250000, { companies: 2 }),
		person(FRIEND, "Asger", 30, 0),
		person(OTHER, "Bo", 12, 340000),
	],
	companies: [
		{ profile_id: COMPANY, name: "Dekora", members: [ME], tasks: 114, revenue_ore: 1250000 },
		{ profile_id: CAFE, name: "Havnens Kaffebar", members: [FRIEND, OTHER], tasks: 42, revenue_ore: 0 },
	],
};

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("leaderboard answers", () => {
	it("reads people and companies", () => {
		const board = parseLeaderboard(BOARD);
		expect(board.people.map((row) => [row.displayName, row.me, row.tasks, row.revenueOre])).toEqual([
			["Jonas", true, 12, 1250000],
			["Asger", false, 30, 0],
			["Bo", false, 12, 340000],
		]);
		expect(board.companies[0]).toEqual({
			profileId: COMPANY,
			name: "Dekora",
			members: [ME],
			tasks: 114,
			revenueOre: 1250000,
		});
	});

	it("refuses an answer it cannot trust", () => {
		expect(() => parseLeaderboard({ ...BOARD, since: "soon" })).toThrow(CloudShapeError);
		expect(() => parseLeaderboard({ ...BOARD, people: [person(ME, "Jonas", -1, 0)] })).toThrow(CloudShapeError);
		expect(() => parseLeaderboard({ ...BOARD, hidden: "no" })).toThrow(CloudShapeError);
	});

	it("keeps a friend's last online time only for an accepted friend", () => {
		const row = {
			user_id: FRIEND,
			email: "asger@example.test",
			display_name: "Asger",
			direction: "outgoing",
			since: "2026-11-08T10:00:00Z",
			last_seen_at: "2026-11-09T09:00:00Z",
		};
		const [accepted, pending] = parseFriends([
			{ ...row, status: "accepted" },
			{ ...row, status: "pending" },
		]);
		expect(accepted!.lastSeenAt).toBe("2026-11-09T09:00:00Z");
		expect(pending!.lastSeenAt).toBeUndefined();
	});
});

describe("last online", () => {
	const now = Date.parse("2026-11-09T12:00:00Z");
	it("says online now for five minutes after a mark, then how long ago", () => {
		expect(lastOnline("2026-11-09T11:57:00Z", now)).toEqual({ online: true, text: "Online now" });
		expect(lastOnline("2026-11-09T11:40:00Z", now)).toEqual({ online: false, text: "Last online 20 minutes ago" });
		expect(lastOnline("2026-11-09T09:00:00Z", now)?.text).toBe("Last online 3 hours ago");
		expect(lastOnline("2026-11-08T09:00:00Z", now)?.text).toBe("Last online yesterday");
		expect(lastOnline("2026-10-01T09:00:00Z", now)?.text).toMatch(/^Last online Oct 1, 2026$/);
		expect(lastOnline(undefined, now)).toBeNull();
		expect(lastOnline("not a time", now)).toBeNull();
	});
});

describe("online marks", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("marks when asked and every four minutes while signed in", async () => {
		const mark = vi.fn(async () => {});
		let signedIn = false;
		const watch = watchOnline(mark, () => signedIn);
		watch.mark();
		expect(mark).not.toHaveBeenCalled();
		signedIn = true;
		watch.mark();
		await vi.advanceTimersByTimeAsync(0);
		expect(mark).toHaveBeenCalledTimes(1);
		// Focus right after a mark does not mark again.
		window.dispatchEvent(new Event("focus"));
		expect(mark).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(mark).toHaveBeenCalledTimes(2);
		watch.stop();
		await vi.advanceTimersByTimeAsync(8 * 60_000);
		expect(mark).toHaveBeenCalledTimes(2);
	});

	it("stops for good on a cloud without the function", async () => {
		const mark = vi.fn(async () => {
			throw new CloudRpcError("qorpera_mark_online", { message: "missing", code: "PGRST202" });
		});
		const watch = watchOnline(mark, () => true);
		watch.mark();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(12 * 60_000);
		watch.mark();
		expect(mark).toHaveBeenCalledTimes(1);
	});
});

describe("leaderboard page", () => {
	async function mount(board: Leaderboard = parseLeaderboard(BOARD)) {
		const api = {
			getFriendsLeaderboard: vi.fn(async () => board),
			setLeaderboardHidden: vi.fn(async (_hidden: boolean) => {}),
		};
		const openFriends = vi.fn();
		const view = new LeaderboardView(api as unknown as CloudApi, new AbortController().signal, openFriends);
		document.body.append(view.el);
		await vi.waitFor(() => expect(view.el.querySelector(".leaderboard-row")).not.toBeNull());
		return { view, api, openFriends };
	}
	const rows = (root: HTMLElement) =>
		[...root.querySelectorAll(".leaderboard-row")].map((row) => [
			row.querySelector(".leaderboard-place")!.textContent,
			row.querySelector(".leaderboard-who strong")!.textContent,
			row.querySelector(".leaderboard-score strong")!.textContent,
		]);
	const pick = (root: HTMLElement, value: string) =>
		root.querySelector<HTMLButtonElement>(`.leaderboard-bar [data-value="${value}"]`)!.click();
	const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.leaderboard-visible [role="switch"]')!;
	const settled = (root: HTMLElement) =>
		vi.waitFor(() => expect(toggle(root).getAttribute("aria-disabled")).toBeNull());

	it("ranks your friends by tasks done this week, with shared places for ties", async () => {
		const { view } = await mount();
		expect(rows(view.el)).toEqual([
			["1", "Asger", "30"],
			["2", "Jonas", "12"],
			["2", "Bo", "12"],
		]);
		expect(view.el.querySelector(".is-me .leaderboard-who small")?.textContent).toBe("You · 2 companies");
		expect(view.el.querySelector(".is-place-1 .leaderboard-who strong")?.textContent).toBe("Asger");
		expect(view.el.querySelector('[data-value="busiest"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(view.el.querySelector('[data-value="friends"]')?.getAttribute("aria-pressed")).toBe("true");
	});

	it("ranks by revenue, and companies as well as friends", async () => {
		const { view } = await mount();
		pick(view.el, "revenue");
		expect(view.el.querySelector(".leaderboard-about")?.textContent).toBe("All sales so far, without VAT.");
		// Revenue in kroner; nobody with nothing yet gets a place.
		expect(rows(view.el)).toEqual([
			["1", "Jonas", "DKK\u00a012,500"],
			["2", "Bo", "DKK\u00a03,400"],
			["–", "Asger", "DKK\u00a00"],
		]);
		pick(view.el, "companies");
		expect(rows(view.el)).toEqual([
			["1", "Dekora", "DKK\u00a012,500"],
			["–", "Havnens Kaffebar", "DKK\u00a00"],
		]);
		expect(view.el.querySelector(".is-me .leaderboard-who small")?.textContent).toBe("You");
		pick(view.el, "busiest");
		expect(rows(view.el)).toEqual([
			["1", "Dekora", "114"],
			["2", "Havnens Kaffebar", "42"],
		]);
		expect(view.el.querySelectorAll(".leaderboard-who small")[1]?.textContent).toBe("Asger, Bo");
	});

	it("takes you off your friends' boards with the switch", async () => {
		const { view, api } = await mount();
		await settled(view.el);
		expect(toggle(view.el).getAttribute("aria-checked")).toBe("true");
		toggle(view.el).click();
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(true));
		await vi.waitFor(() => expect(toggle(view.el).getAttribute("aria-checked")).toBe("false"));
		expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("don't see you");
	});

	it("keeps a saved visibility when an older board read lands after it", async () => {
		const hidden = parseLeaderboard({ ...BOARD, hidden: true });
		const { view, api } = await mount(hidden);
		await settled(view.el);
		const answer = deferred<Leaderboard>();
		api.getFriendsLeaderboard.mockImplementationOnce(() => answer.promise);
		void view.load();
		toggle(view.el).removeAttribute("aria-disabled");
		toggle(view.el).click();
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(false));
		// The read was asked before the save and answers after it, with the old choice.
		answer.resolve(hidden);
		await vi.waitFor(() => expect(view.el.querySelector(".leaderboard-list")?.hasAttribute("aria-busy")).toBe(false));
		expect(toggle(view.el).getAttribute("aria-checked")).toBe("true");
		expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("Your friends see you");
	});

	it("keeps a saved visibility when a read starts while the save is on its way", async () => {
		const hidden = parseLeaderboard({ ...BOARD, hidden: true });
		const { view, api } = await mount(hidden);
		await settled(view.el);
		const saved = deferred<void>();
		api.setLeaderboardHidden.mockImplementationOnce(() => saved.promise);
		const answer = deferred<Leaderboard>();
		api.getFriendsLeaderboard.mockImplementationOnce(() => answer.promise);
		toggle(view.el).click();
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(false));
		void view.load();
		saved.resolve();
		await vi.waitFor(() => expect(toggle(view.el).hasAttribute("aria-busy")).toBe(false));
		answer.resolve(hidden);
		await vi.waitFor(() => expect(view.el.querySelector(".leaderboard-list")?.hasAttribute("aria-busy")).toBe(false));
		expect(toggle(view.el).getAttribute("aria-checked")).toBe("true");
	});

	it("believes a read started after a save whose answer was lost", async () => {
		const { view, api } = await mount();
		await settled(view.el);
		toggle(view.el).click();
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenLastCalledWith(true));
		await settled(view.el);
		// Showing again commits, but the answer is lost; the next read says the account shows.
		api.setLeaderboardHidden.mockRejectedValueOnce(new Error("The connection was lost."));
		toggle(view.el).click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("The connection was lost."));
		await view.load();
		expect(view.el.textContent).not.toContain("The connection was lost.");
		expect(toggle(view.el).getAttribute("aria-checked")).toBe("true");
	});

	it("asks for friends when there are none", async () => {
		const alone = parseLeaderboard({ ...BOARD, people: [person(ME, "Jonas", 12, 0)] });
		const { view, openFriends } = await mount(alone);
		view.el.querySelector<HTMLButtonElement>(".leaderboard-invite button")!.click();
		expect(openFriends).toHaveBeenCalledTimes(1);
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
