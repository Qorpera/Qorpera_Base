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
const AGENT = "11111111-1111-4111-8111-000000000004";

function person(userId: string, name: string, runs: number, extra: Record<string, unknown> = {}) {
	return {
		user_id: userId,
		display_name: name,
		me: userId === ME,
		last_seen_at: null,
		active_days: 2,
		messages: 3,
		companies: 1,
		agents: 4,
		agent_runs: runs,
		agent_hours: 1.5,
		sales_ore: 0,
		...extra,
	};
}

const BOARD = {
	days: 7,
	since: "2026-11-02T10:00:00Z",
	hidden: false,
	people: [person(ME, "Jonas", 12), person(FRIEND, "Asger", 30), person(OTHER, "Bo", 12)],
	companies: [
		{
			profile_id: COMPANY,
			name: "Dekora",
			members: [ME],
			agents: 7,
			agent_runs: 132,
			agent_hours: 4.7,
			sales_ore: 1250000,
		},
	],
	agents: [
		{
			profile_id: COMPANY,
			staff_agent_id: AGENT,
			display_name: "Co-Founder",
			role: "Co-Founder",
			appearance_color: "native",
			appearance_shape: "round",
			template_id: "co-founder",
			company_name: "Dekora",
			runs: 36,
			finished: 36,
			saved: 26,
		},
	],
};

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("leaderboard answers", () => {
	it("reads people, companies and agents", () => {
		const board = parseLeaderboard(BOARD);
		expect(board.days).toBe(7);
		expect(board.people.map((row) => [row.displayName, row.me, row.agentRuns])).toEqual([
			["Jonas", true, 12],
			["Asger", false, 30],
			["Bo", false, 12],
		]);
		expect(board.companies[0]).toMatchObject({ name: "Dekora", members: [ME], agentHours: 4.7, salesOre: 1250000 });
		expect(board.agents[0]).toMatchObject({
			displayName: "Co-Founder",
			appearance: { color: "native", shape: "round" },
			templateId: "co-founder",
			saved: 26,
		});
	});

	it("refuses an answer it cannot trust", () => {
		expect(() => parseLeaderboard({ ...BOARD, days: 14 })).toThrow(CloudShapeError);
		expect(() => parseLeaderboard({ ...BOARD, people: [person(ME, "Jonas", -1)] })).toThrow(CloudShapeError);
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
			setLeaderboardHidden: vi.fn(async () => {}),
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

	it("ranks people with shared places for ties and marks your own row", async () => {
		const { view } = await mount();
		expect(rows(view.el)).toEqual([
			["1", "Asger", "30"],
			["2", "Jonas", "12"],
			["2", "Bo", "12"],
		]);
		expect(view.el.querySelector(".is-me .leaderboard-who strong")?.textContent).toBe("Jonas");
		expect(view.el.querySelector(".is-place-1 .leaderboard-who strong")?.textContent).toBe("Asger");
	});

	it("ranks by another figure, and shows companies and agents", async () => {
		const { view } = await mount();
		[...view.el.querySelectorAll<HTMLButtonElement>(".leaderboard-metrics button")]
			.find((button) => button.textContent === "Messages")!
			.click();
		expect(rows(view.el).map((row) => row[2])).toEqual(["3", "3", "3"]);
		view.el.querySelector<HTMLButtonElement>('[data-board="companies"]')!.click();
		expect(rows(view.el)).toEqual([["1", "Dekora", "132"]]);
		expect(view.el.querySelector(".leaderboard-row.is-me")).not.toBeNull();
		view.el.querySelector<HTMLButtonElement>('[data-board="agents"]')!.click();
		expect(rows(view.el)).toEqual([["1", "Co-Founder", "36"]]);
		// The role is left out when it is the name; an agent of your own company is marked as yours.
		expect(view.el.querySelector(".leaderboard-who small")?.textContent).toBe("Dekora");
		expect(view.el.querySelector(".leaderboard-row.is-me")).not.toBeNull();
	});

	it("reads 30 days when asked, and takes you off your friends' boards", async () => {
		const { view, api } = await mount();
		view.el.querySelector<HTMLButtonElement>('[data-days="30"]')!.click();
		await vi.waitFor(() => expect(api.getFriendsLeaderboard).toHaveBeenLastCalledWith(30));
		const visible = view.el.querySelector<HTMLInputElement>(".leaderboard-visible input")!;
		await vi.waitFor(() => expect(visible.disabled).toBe(false));
		expect(visible.checked).toBe(true);
		visible.checked = false;
		visible.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(true));
		await vi.waitFor(() =>
			expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("don't see you"),
		);
	});

	it("keeps a saved visibility when an older board read lands after it", async () => {
		const hidden = parseLeaderboard({ ...BOARD, hidden: true });
		const { view, api } = await mount(hidden);
		let answer: (board: Leaderboard) => void = () => {};
		api.getFriendsLeaderboard.mockImplementationOnce(() => new Promise<Leaderboard>((resolve) => (answer = resolve)));
		view.el.querySelector<HTMLButtonElement>('[data-days="30"]')!.click();
		const visible = view.el.querySelector<HTMLInputElement>(".leaderboard-visible input")!;
		expect(visible.checked).toBe(false);
		visible.checked = true;
		visible.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(false));
		// The 30-day read was asked before the save and answers after it, with the old choice.
		answer({ ...hidden, days: 30 });
		await vi.waitFor(() =>
			expect(view.el.querySelector('[data-days="30"]')?.getAttribute("aria-pressed")).toBe("true"),
		);
		await vi.waitFor(() => expect(view.el.querySelector(".leaderboard-list")?.hasAttribute("aria-busy")).toBe(false));
		expect(visible.checked).toBe(true);
		expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("Your friends see your row");
	});

	it("keeps a saved visibility when the period changes while the save is on its way", async () => {
		const hidden = parseLeaderboard({ ...BOARD, hidden: true });
		const { view, api } = await mount(hidden);
		let saved: () => void = () => {};
		api.setLeaderboardHidden.mockImplementationOnce(() => new Promise<void>((resolve) => (saved = resolve)));
		let answer: (board: Leaderboard) => void = () => {};
		api.getFriendsLeaderboard.mockImplementationOnce(() => new Promise<Leaderboard>((resolve) => (answer = resolve)));
		const visible = view.el.querySelector<HTMLInputElement>(".leaderboard-visible input")!;
		visible.checked = true;
		visible.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenCalledWith(false));
		// The period changes while the save is out; the save lands, then the read with the old choice.
		view.el.querySelector<HTMLButtonElement>('[data-days="30"]')!.click();
		await vi.waitFor(() => expect(api.getFriendsLeaderboard).toHaveBeenLastCalledWith(30));
		saved();
		await vi.waitFor(() => expect(visible.disabled).toBe(false));
		answer({ ...hidden, days: 30 });
		await vi.waitFor(() => expect(view.el.querySelector(".leaderboard-list")?.hasAttribute("aria-busy")).toBe(false));
		expect(visible.checked).toBe(true);
		expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("Your friends see your row");
	});

	it("believes a read started after a save whose answer was lost", async () => {
		const { view, api } = await mount();
		const visible = view.el.querySelector<HTMLInputElement>(".leaderboard-visible input")!;
		await vi.waitFor(() => expect(visible.disabled).toBe(false));
		visible.checked = false;
		visible.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(api.setLeaderboardHidden).toHaveBeenLastCalledWith(true));
		await vi.waitFor(() => expect(visible.disabled).toBe(false));
		// Showing again commits, but the answer is lost; the next read says the account shows.
		api.setLeaderboardHidden.mockRejectedValueOnce(new Error("The connection was lost."));
		visible.checked = true;
		visible.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(view.el.textContent).toContain("The connection was lost."));
		view.el.querySelector<HTMLButtonElement>('[data-days="30"]')!.click();
		await vi.waitFor(() => expect(api.getFriendsLeaderboard).toHaveBeenLastCalledWith(30));
		await vi.waitFor(() => expect(view.el.textContent).not.toContain("The connection was lost."));
		expect(visible.checked).toBe(true);
		expect(view.el.querySelector(".leaderboard-visible small")?.textContent).toContain("Your friends see your row");
	});

	it("asks for friends when there are none", async () => {
		const alone = parseLeaderboard({ ...BOARD, people: [person(ME, "Jonas", 12)] });
		const { view, openFriends } = await mount(alone);
		view.el.querySelector<HTMLButtonElement>(".leaderboard-invite button")!.click();
		expect(openFriends).toHaveBeenCalledTimes(1);
	});
});
