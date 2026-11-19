// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { ThreadReady } from "../src/app/views/thread-ready.ts";
import { whatsNewEntry } from "../src/app/views/whats-new.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CodeReleaseAnswer, CodeReleaseSite, CodeReleases, SitePreviewAnswer } from "../src/cloud/releases.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import conversationCss from "../src/styles/conversation.css?raw";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

/* "A change is ready" in the agent's thread (own code storage, thread pieces): the card below the thread of the agent
 * behind the change, What's new's own buttons and answers through What's new's desk, and the exchange it settles on. */

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Kaya", templateId: "co-founder" };
const bo: HostedStaffAgent = { ...staff, id: id(41), displayName: "Bo", role: "Developer" };
const left: HostedStaffAgent = { ...bo, id: id(42), displayName: "Otto", employmentStatus: "archived" };
const TICKET = "Tk3_-9aZqLm0PxW2vB8nC4dE6fG1hJ5kR7sU0yQwXeA";
const NEXT = `https://saml-gift-message--next.qorpera.com/.qorpera/enter?t=${TICKET}`;

/** The gift message project: version 3 live, a change ready from Bo with two more riding along. */
function gift(extra: Partial<CodeReleaseSite> = {}): CodeReleaseSite {
	return {
		owner: "qorpera",
		name: "saml-gift-message",
		site: { slug: "saml-gift-message", url: "https://saml-gift-message.qorpera.com/", title: "SAML gift message" },
		live: { version: 3, kind: "release", since: timestamp, by: userA.id },
		back: { version: 2 },
		ready: {
			change: 17,
			token: TOKEN,
			agent: bo.id,
			changes: [
				{
					key: 17,
					notice: "The checkout shows the gift message.",
					picture: "code/qorpera/saml-gift-message/changes/17.png",
					at: timestamp,
					wasLive: false,
				},
				{ key: 16, notice: "Sizes are easier to pick.", picture: null, at: timestamp, wasLive: false },
			],
			quiet: 1,
		},
		waiting: 0,
		problem: null,
		givenUp: false,
		...extra,
	};
}
/** A second project with nothing ready. */
const quietProject = (): CodeReleaseSite => ({
	...gift(),
	name: "wristband-shop",
	site: { slug: "wristband-shop", url: "https://wristband-shop.qorpera.com/", title: "Wristband shop" },
	ready: null,
});
const live4 = () =>
	gift({ live: { version: 4, kind: "release", since: timestamp, by: userA.id }, back: { version: 3 }, ready: null });

const releasesOf = (sites: CodeReleaseSite[], canRelease = true, preview = false): CodeReleases => ({
	canRelease,
	preview,
	sites,
});

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	URL.createObjectURL = vi.fn(() => "blob:picture-1");
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	localStorage.clear();
	location.hash = "";
	setLanguagePreference("system");
	Reflect.deleteProperty(navigator, "clipboard");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

interface Setup {
	role?: "owner" | "contributor";
	agents?: HostedStaffAgent[];
	/** The thread's agent. */
	agent?: string;
	putLive?: () => Promise<CodeReleaseAnswer>;
	openPreview?: () => Promise<SitePreviewAnswer>;
	takenDown?: ReadonlySet<string>;
}

function company(role: "owner" | "contributor" = "owner", agents: HostedStaffAgent[] = [cofounder, bo], agent = bo.id) {
	const controller = new CompanyController(fixture().api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: agents,
		sessions: [{ ...session, staffAgentId: agent }],
		team: {
			...team,
			role,
			members: [{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role, joinedAt: timestamp }],
		},
	});
	cleanup.push(() => controller.stop());
	return controller;
}

function calls(reads: CodeReleases[], options: Setup) {
	const queue = [...reads];
	return {
		list: vi.fn(async () => structuredClone(queue.length > 1 ? queue.shift()! : queue[0]!)),
		putLive: vi.fn(async () => (options.putLive ? options.putLive() : ({ state: "live", version: 4 } as const))),
		goBack: vi.fn(async (): Promise<CodeReleaseAnswer> => ({ state: "live", version: 2 })),
		openPreview: vi.fn(
			async (): Promise<SitePreviewAnswer> =>
				options.openPreview ? options.openPreview() : { state: "open", url: NEXT },
		),
	};
}

async function card(reads: CodeReleases[], options: Setup = {}) {
	const controller = company(options.role, options.agents, options.agent);
	const client = calls(reads, options);
	const listed = vi.fn();
	const focusComposer = vi.fn();
	const shownChanged = vi.fn();
	const image = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
	const lifetime = new AbortController();
	const ready = new ThreadReady(
		controller,
		session.sessionId,
		client,
		{ image, listed, ...(options.takenDown ? { takenDown: async () => options.takenDown! } : {}) },
		lifetime.signal,
		{ agentId: () => options.agent ?? bo.id, focusComposer, shownChanged },
	);
	cleanup.push(() => lifetime.abort());
	document.body.append(ready.el);
	await settle();
	return { controller, client, ready, listed, focusComposer, shownChanged, image };
}

const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const labels = (root: Element) => buttons(root).map((item) => item.textContent);
const press = (root: Element, label: string) =>
	buttons(root)
		.find((item) => item.textContent === label)!
		.click();
const cardOf = (ready: ThreadReady) =>
	ready.el.querySelector<HTMLElement>('[data-ready-site="qorpera/saml-gift-message"]')!;
/** Nothing technical: no change number, commit, repository path, check or the word release. */
function plain(root: Element) {
	expect(root.textContent ?? "").not.toMatch(
		/\b(?:17|16)\b|qorpera\/|code\/|commit|branch|\bchecks?\b|release|token/i,
	);
}

describe("A change is ready: the card", () => {
	it("stands in the thread of the agent behind the change: Ready to go live, the picture large, its line, the rest as a way to What's new", async () => {
		const { ready, image, shownChanged } = await card([releasesOf([gift(), quietProject()])]);
		expect(ready.shown).toBe(true);
		expect(shownChanged).toHaveBeenCalledOnce();
		// One card, for the project with a change ready; none for the one with nothing ready.
		expect(ready.el.querySelectorAll(".thread-ready-card")).toHaveLength(1);
		const shown = cardOf(ready);
		// The thread's widget that waits for the member: a question's frame, the agent's figure, "Ready to go live", and the
		// project after it, quiet, as the company has two projects that make a site.
		expect(shown.className).toBe("interaction-card is-asking thread-ready-card");
		expect(shown.querySelector(".interaction-call strong")?.textContent).toBe("Ready to go live");
		expect(shown.querySelector(".interaction-call .thread-ready-project")?.textContent).toBe("SAML gift message");
		expect(shown.querySelector(".interaction-call .interaction-figure .figure")).not.toBeNull();
		// The newest change a customer will notice: What's new's own tile, its picture read the same way.
		const tile = shown.querySelector<HTMLElement>(".whats-new-change.is-thread")!;
		expect(tile.querySelector("img")?.getAttribute("src")).toBe("blob:picture-1");
		expect(image).toHaveBeenCalledWith("code/qorpera/saml-gift-message/changes/17.png", expect.any(AbortSignal));
		expect(shown.querySelectorAll(".whats-new-line")).toHaveLength(1);
		expect(tile.querySelector(".whats-new-line")?.textContent).toBe("The checkout shows the gift message.");
		expect(shown.querySelector(".whats-new-behind")).toBeNull();
		const more = shown.querySelector<HTMLAnchorElement>("a.thread-ready-more")!;
		expect(more.textContent).toBe("and 2 more changes");
		expect(more.getAttribute("data-href") ?? more.getAttribute("href")).toBe(`#/c/${profileA.profileId}/whats-new`);
		expect(labels(shown.querySelector(".whats-new-actions")!)).toEqual(["Put it live", "Not yet"]);
		plain(shown);
		// A draw keeps the tile and its picture as they are.
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(cardOf(ready).querySelector(".whats-new-change")).toBe(tile);
	});

	it("says nothing more for one change, one more for two, and only changes behind the scenes in What's new's words", async () => {
		const one = await card([
			releasesOf([gift({ ready: { ...gift().ready!, changes: [gift().ready!.changes[0]!], quiet: 0 } })]),
		]);
		expect(cardOf(one.ready).querySelector(".thread-ready-more")).toBeNull();
		// A company with one project that makes a site: the head is "Ready to go live" alone.
		expect(cardOf(one.ready).querySelector(".thread-ready-project")).toBeNull();
		const two = await card([
			releasesOf([gift({ ready: { ...gift().ready!, changes: [gift().ready!.changes[0]!], quiet: 1 } })]),
		]);
		expect(cardOf(two.ready).querySelector(".thread-ready-more")?.textContent).toBe("and 1 more change");
		const quiet = await card([releasesOf([gift({ ready: { ...gift().ready!, changes: [], quiet: 2 } })])]);
		expect(cardOf(quiet.ready).querySelector(".whats-new-change, .thread-ready-more")).toBeNull();
		expect(cardOf(quiet.ready).querySelector(".whats-new-line")?.textContent).toBe("2 changes behind the scenes");
	});

	it("is not in another agent's thread; the Co-Founder's thread has it when no agent made it, or the agent left", async () => {
		const other = await card([releasesOf([gift()])], { agent: cofounder.id });
		expect(other.ready.shown).toBe(false);
		expect(other.ready.el.children).toHaveLength(0);
		const nobody = await card([releasesOf([gift({ ready: { ...gift().ready!, agent: null } })])], {
			agent: cofounder.id,
		});
		expect(nobody.ready.shown).toBe(true);
		const gone = await card([releasesOf([gift({ ready: { ...gift().ready!, agent: left.id } })])], {
			agent: cofounder.id,
			agents: [cofounder, bo, left],
		});
		expect(gone.ready.shown).toBe(true);
		const notHis = await card([releasesOf([gift({ ready: { ...gift().ready!, agent: left.id } })])], {
			agent: left.id,
			agents: [cofounder, bo, left],
		});
		expect(notHis.ready.shown).toBe(false);
	});

	it("offers Look first before Put it live while the read offers it, and never to anyone else", async () => {
		const { ready } = await card([releasesOf([gift()], true, true)]);
		expect(labels(cardOf(ready))).toEqual(["Look first", "Put it live", "Not yet"]);
		const member = await card([releasesOf([gift()], false, false)], { role: "contributor" });
		const shown = cardOf(member.ready);
		// Everyone else reads the picture, its line and who puts changes live.
		expect(labels(shown)).toEqual([]);
		expect(shown.querySelector(".whats-new-managers")?.textContent).toBe("Founders and admins put changes live.");
		expect(shown.querySelector(".whats-new-change img")).not.toBeNull();
	});

	it("puts it live as What's new does: its buttons keep their words and go off, then the exchange it was, with the version and the site's link", async () => {
		const answer = deferred<CodeReleaseAnswer>();
		const { ready, client, listed } = await card([releasesOf([gift()]), releasesOf([live4()])], {
			putLive: () => answer.promise,
		});
		press(cardOf(ready), "Put it live");
		await settle();
		expect(client.putLive).toHaveBeenCalledWith(
			"qorpera",
			"saml-gift-message",
			{ live: 3, change: 17, token: TOKEN },
			expect.any(AbortSignal),
		);
		// The row never changes width in a thread: the same words, all off, the pressed one busy (the review of #1850).
		expect(
			buttons(cardOf(ready)).map((item) => [item.textContent, item.disabled, item.getAttribute("aria-busy")]),
		).toEqual([
			["Put it live", true, "true"],
			["Not yet", true, null],
		]);
		answer.resolve({ state: "live", version: 4 });
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(listed).toHaveBeenLastCalledWith(releasesOf([live4()]));
		const settled = cardOf(ready);
		expect(settled.className).toBe("interaction-card is-exchange thread-ready-card is-settled");
		// What the agent offered as its bubble, the member's own "Put it live" on their side, then one quiet line.
		// The company has one project that makes a site: the agent's bubble is the change's line alone.
		expect(settled.querySelector(".interaction-ask.bubble")?.textContent).toBe(
			"The checkout shows the gift message.",
		);
		const said = settled.querySelector(".interaction-result.is-said.mine > .interaction-chosen.bubble");
		expect(said?.textContent).toBe("Put it live");
		const line = settled.querySelector<HTMLElement>(".interaction-result.is-done.thread-ready-live")!;
		expect(line.querySelector(".review-mark.is-approved")).not.toBeNull();
		expect(line.textContent).toContain("Version 4 is live.");
		// The site's address, a plain quiet link with the small arrow, never a framed pill.
		const address = line.querySelector<HTMLAnchorElement>("a.thread-ready-address")!;
		expect(address.textContent).toBe("saml-gift-message.qorpera.com");
		expect(address.href).toBe("https://saml-gift-message.qorpera.com/");
		expect(address.target).toBe("_blank");
		expect(address.rel).toBe("noopener noreferrer");
		expect(address.querySelector("svg")).not.toBeNull();
		expect(line.querySelector(".site-pill")).toBeNull();
		expect(settled.querySelector(".whats-new-actions")).toBeNull();
		plain(settled);
		// It stays while the thread is open, through later reads.
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(cardOf(ready).classList.contains("is-settled")).toBe(true);
		expect(ready.shown).toBe(true);
	});

	it("puts the project's name first in the agent's bubble once settled, only where the company has several", async () => {
		const { ready } = await card([releasesOf([gift(), quietProject()]), releasesOf([live4(), quietProject()])]);
		press(cardOf(ready), "Put it live");
		await settle();
		const ask = cardOf(ready).querySelector(".interaction-ask.bubble")!;
		expect([...ask.children].map((child) => [child.className, child.textContent])).toEqual([
			["thread-ready-project", "SAML gift message"],
			["interaction-text", "The checkout shows the gift message."],
		]);
	});

	it("settles once the read after an answer that never came shows the change live, and claims nothing before", async () => {
		const answer = deferred<CodeReleaseAnswer>();
		const { ready } = await card([releasesOf([gift()]), releasesOf([live4()])], { putLive: () => answer.promise });
		press(cardOf(ready), "Put it live");
		await settle();
		expect(cardOf(ready).classList.contains("is-settled")).toBe(false);
		answer.reject(new CloudRpcError("x", { message: "TypeError: Failed to fetch", code: "" }, 0));
		await settle();
		expect(cardOf(ready).classList.contains("is-settled")).toBe(true);
		expect(cardOf(ready).textContent).toContain("Version 4 is live.");
	});

	it("claims nothing when the read after an answer that never came shows nothing changed", async () => {
		const lost = () => Promise.reject(new CloudRpcError("x", { message: "TypeError: Failed to fetch", code: "" }, 0));
		const { ready } = await card([releasesOf([gift()])], { putLive: lost });
		press(cardOf(ready), "Put it live");
		await settle();
		expect(cardOf(ready).classList.contains("is-settled")).toBe(false);
		expect(labels(cardOf(ready))).toEqual(["Put it live", "Not yet"]);
	});

	it("says what changed when the page moved, and reads it again", async () => {
		const newer = gift({ ready: { ...gift().ready!, change: 18, token: OTHER_TOKEN } });
		const { ready, client } = await card([releasesOf([gift()]), releasesOf([newer])], {
			putLive: async () => ({ state: "moved" }),
		});
		press(cardOf(ready), "Put it live");
		await settle();
		const shown = cardOf(ready);
		expect(shown.querySelector(".interaction-call + .service-outcome.is-ok")?.textContent).toBe(
			"Something changed while you looked. Here is what is ready now.",
		);
		expect(client.list).toHaveBeenCalledTimes(2);
		press(shown, "Put it live");
		await settle();
		expect(client.putLive).toHaveBeenLastCalledWith(
			"qorpera",
			"saml-gift-message",
			{ live: 3, change: 18, token: OTHER_TOKEN },
			expect.any(AbortSignal),
		);
	});

	it("says a write Qorpera refused for a site it took down, in What's new's words, and that nothing changed", async () => {
		const { ready } = await card([releasesOf([gift()])], {
			putLive: async () => ({ state: "refused", code: "SITE_TAKEN_DOWN" }),
		});
		press(cardOf(ready), "Put it live");
		await settle();
		expect(cardOf(ready).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent).toBe(
			"It did not go live: Qorpera took this site down. Nothing changed.",
		);
	});

	it("draws no card for a site Qorpera took down: one quiet line in What's new's words, its Sites a way there", async () => {
		const { ready } = await card([releasesOf([gift()], true, true)], { takenDown: new Set(["saml-gift-message"]) });
		expect(ready.shown).toBe(true);
		expect(ready.el.querySelector(".thread-ready-card, .whats-new-change, button")).toBeNull();
		const line = ready.el.querySelector<HTMLElement>("p.conversation-note.thread-ready-down")!;
		expect(line.textContent).toBe("Qorpera took this site down, so it can't be opened. See why in Sites.");
		const sites = line.querySelector<HTMLAnchorElement>("a")!;
		expect(sites.textContent).toBe("Sites");
		expect(sites.getAttribute("data-href") ?? sites.getAttribute("href")).toBe(`#/c/${profileA.profileId}/sites`);
		setLanguagePreference("da");
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(ready.el.querySelector(".thread-ready-down a")?.textContent).toBe("Hjemmesider");
	});

	it("says Put it live for a project's first version too, so its row of buttons is the same row (What's new's page names the first version)", async () => {
		const first = await card([releasesOf([gift({ live: null, back: null })], true, true)]);
		expect(labels(cardOf(first.ready))).toEqual(["Look first", "Put it live", "Not yet"]);
	});

	it("opens Look first's tab within the press and answers `moved` in What's new's words", async () => {
		const tab = { opener: window as unknown, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
		const open = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
		const answer = deferred<SitePreviewAnswer>();
		const { ready, client } = await card([releasesOf([gift()], true, true)], { openPreview: () => answer.promise });
		press(cardOf(ready), "Look first");
		// Blank, within the press, its way back cut.
		expect(open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(tab.opener).toBeNull();
		await settle();
		expect(labels(cardOf(ready))).toEqual(["Look first", "Put it live", "Not yet"]);
		expect(buttons(cardOf(ready)).map((item) => item.getAttribute("aria-busy"))).toEqual(["true", null, null]);
		answer.resolve({ state: "moved" });
		await settle();
		expect(tab.close).toHaveBeenCalled();
		expect(tab.location.replace).not.toHaveBeenCalled();
		expect(cardOf(ready).querySelector(".service-outcome.is-ok")?.textContent).toBe(
			"Something changed while you looked. Here is what is ready now.",
		);
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("puts Not yet into this thread's composer and the keyboard there, sends nothing, and quiets the badge", async () => {
		const { ready, controller, focusComposer, listed } = await card([releasesOf([gift()])]);
		const opened = vi.spyOn(controller, "openStaffConversation");
		const sent = vi.spyOn(controller, "sendPrompt");
		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		press(cardOf(ready), "Not yet");
		await settle();
		expect(controller.conversation(session.sessionId).get().draft).toBe("Not yet: ");
		expect(focusComposer).toHaveBeenCalledOnce();
		expect(opened).not.toHaveBeenCalled();
		expect(sent).not.toHaveBeenCalled();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(whatsNewEntry(controller, releasesOf([gift()]))).toEqual({ ready: 0 });
		expect(listed).toHaveBeenCalledTimes(2);
		// Not twice.
		press(cardOf(ready), "Not yet");
		await settle();
		expect(controller.conversation(session.sessionId).get().draft).toBe("Not yet: ");
	});

	it("is in Danish", async () => {
		setLanguagePreference("da");
		const { ready } = await card([releasesOf([gift()], true, true)]);
		expect(labels(cardOf(ready))).toEqual(["Se den først", "Sæt live", "Ikke endnu"]);
		expect(cardOf(ready).querySelector(".interaction-call strong")?.textContent).toBe("Klar til at gå live");
	});

	it("starts from the company's last read without one of its own, and reads which sites Qorpera took down beside it", async () => {
		const controller = company();
		const client = calls([releasesOf([gift()], true, true)], {});
		const takenDown = vi.fn(async () => new Set(["saml-gift-message"]) as ReadonlySet<string>);
		const lifetime = new AbortController();
		cleanup.push(() => lifetime.abort());
		const ready = new ThreadReady(controller, session.sessionId, client, { takenDown }, lifetime.signal, {
			agentId: () => bo.id,
			focusComposer: () => {},
			shownChanged: () => {},
			last: () => releasesOf([gift()], true, true),
		});
		document.body.append(ready.el);
		// Drawn at once, from the read the company made.
		expect(ready.shown).toBe(true);
		expect(labels(cardOf(ready))).toEqual(["Look first", "Put it live", "Not yet"]);
		await settle();
		expect(client.list).not.toHaveBeenCalled();
		expect(takenDown).toHaveBeenCalledOnce();
		expect(ready.el.querySelector(".thread-ready-card")).toBeNull();
		expect(ready.el.querySelector(".thread-ready-down")).not.toBeNull();
		// The window coming back reads, as What's new does.
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(client.list).toHaveBeenCalledOnce();
	});

	it("has the settled look of an answered question, and What's new's picture large without a tile's frame", () => {
		expect(conversationCss).toMatch(/\.thread-ready-card \.whats-new-change\.is-thread \{[^}]*border: 0;/);
		expect(conversationCss).toMatch(/\.whats-new-change\.is-thread > \.choice-picture \{[^}]*aspect-ratio: 16 \/ 10/);
		expect(conversationCss).toMatch(/\.thread-ready-live \{[^}]*flex-wrap: wrap/);
		// A question's width, and never wider than a bubble.
		expect(conversationCss).toMatch(/\.thread-ready-card\.is-asking \{ max-width: min\(72%, 720px\); \}/);
	});
});

describe("A change is ready, in the thread", () => {
	/** An agent's thread with one message, drawn once the thread's own reads (its transcript, What's new) answered. */
	async function thread(options: { whatsNew?: boolean } = {}) {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		controller.store.set({
			team: { ...team, role: "owner" },
			staff: [cofounder, bo],
			sessions: [{ ...session, staffAgentId: bo.id }],
			loading: false,
			...(options.whatsNew === false ? {} : { whatsNew: { ready: 3 } }),
		});
		const client = calls([releasesOf([gift()])], {});
		const view = new ConversationView(controller, session.sessionId, {
			codeReleases: { client, options: {} },
		});
		document.body.append(view.el);
		cleanup.push(() => {
			view.dispose();
			controller.stop();
		});
		await settle();
		controller.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "agent",
						id: id(70),
						sequence: 1,
						text: "Your change is ready.",
						attachmentCount: 0,
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 1,
			},
		});
		view.update();
		return { view, client };
	}

	it("stands below the last message, where saved changes wait", async () => {
		const { view } = await thread();
		const log = view.el.querySelector(".messages-log")!;
		const last = [...log.children].at(-1);
		expect(last?.className).toBe("thread-ready");
		expect(last?.previousElementSibling?.matches("article.message")).toBe(true);
		expect(last?.querySelector(".interaction-call strong")?.textContent).toBe("Ready to go live");
	});

	it("reads nothing while the company has no project that makes a website", async () => {
		const { view, client } = await thread({ whatsNew: false });
		expect(client.list).not.toHaveBeenCalled();
		expect(view.el.querySelector(".thread-ready")).toBeNull();
	});
});
