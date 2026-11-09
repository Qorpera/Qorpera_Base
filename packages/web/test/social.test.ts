// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchOnline } from "../src/app/online-mark.ts";
import { FriendsController, lastOnline } from "../src/app/views/friends.ts";
import { LeaderboardView } from "../src/app/views/leaderboard.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { CloudShapeError, parseFriends } from "../src/cloud/parse.ts";
import { type Leaderboard, parseLeaderboard } from "../src/cloud/social.ts";
import type { HostedFriend } from "../src/cloud/types.ts";

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
		last_week_tasks: 0,
		revenue_ore: revenueOre,
		main_profile_id: null,
		...extra,
	};
}

const BOARD = {
	since: "2026-11-09T00:00:00+01:00",
	until: "2099-11-16T00:00:00+01:00",
	week: 46,
	hidden: false,
	people: [
		person(ME, "Jonas", 12, 1250000, { companies: 2, last_week_tasks: 40, main_profile_id: COMPANY }),
		person(FRIEND, "Asger", 30, 0, { last_week_tasks: 5, main_profile_id: CAFE }),
		person(OTHER, "Bo", 12, 340000, { last_week_tasks: 20, main_profile_id: CAFE }),
	],
	companies: [
		{ profile_id: COMPANY, name: "Dekora", members: [ME], tasks: 114, last_week_tasks: 0, revenue_ore: 1250000 },
		{
			profile_id: CAFE,
			name: "Havnens Kaffebar",
			members: [FRIEND, OTHER],
			tasks: 42,
			last_week_tasks: 0,
			revenue_ore: 0,
		},
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
		expect(board.week).toBe(46);
		expect(board.people.map((row) => [row.displayName, row.me, row.tasks, row.lastWeekTasks])).toEqual([
			["Jonas", true, 12, 40],
			["Asger", false, 30, 5],
			["Bo", false, 12, 20],
		]);
		expect(board.companies[0]).toEqual({
			profileId: COMPANY,
			name: "Dekora",
			members: [ME],
			tasks: 114,
			lastWeekTasks: 0,
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

describe("friends list reads", () => {
	it("shows only the newest read when two cross", async () => {
		const older = deferred<HostedFriend[]>();
		const newer = deferred<HostedFriend[]>();
		const listFriends = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		const friends = new FriendsController({ listFriends } as unknown as CloudApi);
		const first = friends.refresh();
		const second = friends.refresh();
		const friend = parseFriends([
			{
				user_id: FRIEND,
				email: "asger@example.test",
				display_name: "Asger",
				status: "accepted",
				direction: "outgoing",
				since: "2026-11-08T10:00:00Z",
			},
		]);
		// The newer read (after a removal: no friends) lands first; the older one, still listing Asger, lands after.
		newer.resolve([]);
		await second;
		older.resolve(friend);
		await first;
		expect(friends.store.get().friends).toEqual([]);
		expect(friends.store.get().loading).toBe(false);
		friends.dispose();
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
			row.querySelector(".leaderboard-move")?.textContent ?? null,
			row.querySelector(".leaderboard-who strong")!.textContent,
			row.querySelector(".leaderboard-score")!.textContent,
		]);
	const pick = (root: HTMLElement, board: string) =>
		root.querySelector<HTMLButtonElement>(`.leaderboard-tabs [data-board="${board}"]`)!.click();
	const champion = (root: HTMLElement) =>
		[...root.querySelectorAll(".leaderboard-champion-copy > *")].map((part) => part.textContent);
	const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.leaderboard-visible [role="switch"]')!;
	const settled = (root: HTMLElement) =>
		vi.waitFor(() => expect(toggle(root).getAttribute("aria-disabled")).toBeNull());

	it("crowns this week's busiest friend and shows who moved up or down", async () => {
		const { view } = await mount();
		expect(view.el.querySelector('[data-board="busy-friends"]')?.getAttribute("aria-selected")).toBe("true");
		expect(champion(view.el)).toEqual([
			"Busiest this week, so far",
			"Asger",
			"30 tasks · 18 tasks ahead of Jonas",
			expect.stringMatching(/^Week 46 ends Sunday at midnight\. \d+ days left to catch up\.$/),
		]);
		// Last week: Jonas 40, Bo 20, Asger 5.
		expect(rows(view.el)).toEqual([
			["1", "▲ 2", "Asger", "30"],
			["2", "▼ 1", "Jonas", "12"],
			["2", "–", "Bo", "12"],
		]);
		expect(view.el.querySelector(".is-me .leaderboard-who small")?.textContent).toBe("You · 19 tasks to pass Asger");
		// People show their own picture (initials until they choose one), never a company's figure.
		expect(view.el.querySelectorAll(".leaderboard-row .person-avatar")).toHaveLength(3);
		expect(view.el.querySelector(".leaderboard-row .company-logo")).toBeNull();
		expect(view.el.querySelector(".leaderboard-champion-figure .person-avatar")?.textContent).toBe("A");
	});

	it("shows the other boards: busiest companies and top earners", async () => {
		const { view } = await mount();
		pick(view.el, "busy-companies");
		// Nobody's company had a task last week: no arrows yet.
		expect(rows(view.el)).toEqual([
			["1", null, "Dekora", "114"],
			["2", null, "Havnens Kaffebar", "42"],
		]);
		expect(view.el.querySelectorAll(".leaderboard-who small")[1]?.textContent).toBe("Asger, Bo");
		// A company shows its logo: its figure, until companies have logos of their own.
		expect(view.el.querySelectorAll(".leaderboard-row .company-logo")).toHaveLength(2);
		expect(view.el.querySelector(".leaderboard-champion-figure .company-logo")).not.toBeNull();
		expect(view.el.querySelector(".is-me .leaderboard-who small")?.textContent).toBe("You · You're in the lead.");
		pick(view.el, "earning-friends");
		// Revenue in kroner, no arrows; nobody with nothing yet gets a place.
		expect(rows(view.el)).toEqual([
			["1", null, "Jonas", "DKK\u00a012,500"],
			["2", null, "Bo", "DKK\u00a03,400"],
			["–", null, "Asger", "DKK\u00a00"],
		]);
		expect(champion(view.el)[0]).toBe("Most revenue so far");
		expect(champion(view.el)[3]).toBe("All sales so far, without VAT.");
		pick(view.el, "earning-companies");
		expect(rows(view.el).map((row) => row[2])).toEqual(["Dekora", "Havnens Kaffebar"]);
	});

	it("crowns a shared first place together, with each total its own", async () => {
		// Jonas has 12 tasks at Dekora and 20 at another company: the banner shows his total, not one company's.
		const tied = parseLeaderboard({
			...BOARD,
			people: [
				person(ME, "Jonas", 30, 0, { companies: 2, main_profile_id: COMPANY }),
				person(FRIEND, "Asger", 30, 0, { main_profile_id: CAFE }),
				person(OTHER, "Bo", 12, 0, { main_profile_id: CAFE }),
			],
		});
		const { view } = await mount(tied);
		expect(champion(view.el).slice(0, 3)).toEqual([
			"Sharing the lead",
			"Jonas and Asger",
			"30 tasks each · 18 tasks ahead of Bo",
		]);
		expect(view.el.querySelectorAll(".leaderboard-champion-figure")).toHaveLength(2);
		expect(rows(view.el).map((row) => row[0])).toEqual(["1", "1", "3"]);
	});

	it("says nobody is ahead yet when the week has no tasks", async () => {
		const quiet = parseLeaderboard({
			...BOARD,
			people: BOARD.people.map((row) => ({ ...row, tasks: 0 })),
		});
		const { view } = await mount(quiet);
		expect(champion(view.el).slice(0, 2)).toEqual(["Busiest this week", "Nobody is ahead yet"]);
		expect(view.el.querySelector(".leaderboard-champion-figure")).toBeNull();
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
