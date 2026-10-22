// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOUNDING_WRITING_MS, FoundingController } from "../src/app/founding.ts";
import { caretIn, FoundingView, newWords } from "../src/app/views/founding.ts";
import type { FoundingLive, FoundingPresenceListener, FoundingPresenceTab } from "../src/cloud/founding-presence.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fixture, id, settle, userA, userB, visibleText } from "./fixtures.ts";

/* Live presence at the founding table (20260930531000) in the page: who is here, who is writing, the newest writer's
 * words in an untouched box, carets with name flags, and your own words going out as you write. The topic itself is
 * stood in for (founding-presence.test.ts covers it). */

const table = id(900);
const me = userA.id;
const bo = userB.id;
const cy = id(903);
const boTab = id(951);
const cyTab = id(953);

type Wire = Record<string, unknown>;

function wire(overrides: Wire = {}, meState: "joined" | "invited" = "joined"): Wire {
	return {
		schema: "qorpera.company-founding/v1",
		profileId: table,
		companyName: "Nordlys Kaffe",
		vision: "Specialty coffee.",
		phase: "open",
		revision: 4,
		createdByUserId: bo,
		seats: [
			{
				userId: bo,
				displayName: "Bo",
				state: "joined",
				role: "Wholesale.",
				invitedByUserId: bo,
				ready: true,
				modelLoginReady: true,
				creator: true,
			},
			{
				userId: me,
				displayName: "Anna",
				state: meState,
				role: "",
				invitedByUserId: bo,
				ready: false,
				modelLoginReady: meState === "joined",
				creator: false,
			},
			{
				userId: cy,
				displayName: "Cy",
				state: "invited",
				role: "",
				invitedByUserId: bo,
				ready: false,
				modelLoginReady: false,
				creator: false,
			},
		],
		waitingFor: meState === "joined" ? [me] : [],
		me: { userId: me, state: meState, canEdit: meState === "joined", canManage: false, canStart: false },
		start: null,
		...overrides,
	};
}

const live = (changes: Partial<FoundingLive> = {}): FoundingLive => ({
	clientId: boTab,
	userId: bo,
	field: "vision",
	text: "Specialty coffee. Roasted in Aarhus.",
	caret: 36,
	typing: true,
	own: true,
	...changes,
});
const tab = (changes: Partial<FoundingPresenceTab> = {}): FoundingPresenceTab => ({
	clientId: boTab,
	userId: bo,
	visible: true,
	field: "vision",
	...changes,
});

describe("live presence at the founding table", () => {
	let container: HTMLElement;
	let controller: FoundingController | undefined;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
		container = document.createElement("div");
		document.body.append(container);
	});
	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setLanguagePreference("system");
	});

	function mount(read: () => Wire = () => wire(), rpc?: (name: string, args: Record<string, unknown>) => unknown) {
		const f = fixture();
		const handle = { setState: vi.fn(), sendLive: vi.fn(), stop: vi.fn(async () => {}) };
		let listener: FoundingPresenceListener | undefined;
		vi.mocked(f.api.joinFoundingPresence).mockImplementation((_profileId, given) => {
			listener = given;
			return handle;
		});
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
			calls.push({ name, args });
			if (rpc) {
				const answer = rpc(name, args);
				if (answer !== undefined) return answer;
			}
			if (name === "qorpera_read_company_founding") return read();
			throw new Error(`Unexpected RPC ${name}`);
		});
		controller = new FoundingController(f.api, me, table, { currentUserId: () => me });
		const view = new FoundingView(controller);
		container.append(view.el);
		controller.store.subscribe(() => view.update());
		view.update();
		const presence = () => {
			if (!listener) throw new Error("not on the table's topic");
			return listener;
		};
		const named = (name: string) => calls.filter((call) => call.name === name).map((call) => call.args);
		return { ...f, view, handle, presence, named, joined: () => listener !== undefined };
	}

	const face = (userId: string) =>
		[...container.querySelectorAll<HTMLElement>(".founding-heads .person-avatar")][
			["bo", "me", "cy"].indexOf(userId === bo ? "bo" : userId === me ? "me" : "cy")
		]!;
	const chip = (userId: string) => container.querySelector<HTMLElement>(`.founding-seat[data-user="${userId}"]`)!;
	const writingLine = () => container.querySelector<HTMLElement>(".founding-writing")!;
	const box = () => container.querySelector<HTMLTextAreaElement>("textarea.founding-vision")!;

	it("shows who is here and who is writing, and stops counting writing a few seconds after the last word", async () => {
		const { presence } = mount();
		await settle();
		// Before the topic answers, the faces keep their colours and nobody is marked here.
		expect(container.querySelector(".founding-heads-live")).toBeNull();
		presence().health("connected");
		await settle();
		presence().tabs([tab({ field: null })]);
		await settle();
		expect(container.querySelector(".founding-heads-live")).not.toBeNull();
		expect(face(me).classList.contains("founding-head-here")).toBe(true);
		expect(face(bo).classList.contains("founding-head-here")).toBe(true);
		expect(face(cy).classList.contains("founding-head-here")).toBe(false);
		expect(chip(bo).classList.contains("founding-seat-here")).toBe(true);
		expect(chip(bo).textContent).toContain("Here now");
		expect(writingLine().hidden).toBe(true);
		presence().tabs([tab()]);
		await settle();
		presence().live(live());
		await settle();
		expect(face(bo).classList.contains("founding-head-writing")).toBe(true);
		expect(visibleText(chip(bo))).toContain("Writing");
		expect(writingLine().hidden).toBe(false);
		expect(visibleText(writingLine())).toBe("Bo is writing");
		// A caret that moves is not writing; the last word counts for a few seconds.
		await vi.advanceTimersByTimeAsync(FOUNDING_WRITING_MS - 500);
		presence().live(live({ caret: 3, typing: false }));
		await settle();
		await vi.advanceTimersByTimeAsync(600);
		expect(writingLine().hidden).toBe(true);
		expect(visibleText(chip(bo))).toContain("Ready ✓");
		expect(face(bo).classList.contains("founding-head-writing")).toBe(false);
		// Bo's tab goes to the background: still at the table, not here now.
		presence().tabs([tab({ visible: false, field: null })]);
		await settle();
		expect(face(bo).classList.contains("founding-head-here")).toBe(false);
		expect(controller!.store.get().present).toEqual([{ userId: bo, here: false, writing: false }]);
	});

	it("follows Bo's words in an untouched idea box, tints his new words and puts his caret and name there", async () => {
		let vision = "Specialty coffee.";
		const { presence, named } = mount(
			() => wire({ vision, revision: vision === "Specialty coffee." ? 4 : 5 }),
			(name, args) =>
				name === "qorpera_set_founder_ready" ? wire({ revision: Number(args.p_expected_revision) }) : undefined,
		);
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ caret: 18 }));
		await settle();
		expect(box().value).toBe("Specialty coffee. Roasted in Aarhus.");
		const layer = container.querySelector<HTMLElement>(".founding-carets")!;
		const tinted = () => [...layer.querySelectorAll("mark.founding-them")].map((mark) => mark.textContent).join("");
		expect(tinted()).toBe(" Roasted in Aarhus.");
		const caret = layer.querySelector<HTMLElement>(".founding-caret")!;
		expect(caret.textContent).toBe("Bo");
		// The caret stands after "Specialty coffee. " (18 units), inside his new words.
		const before = document.createRange();
		before.setStart(layer, 0);
		before.setEndBefore(caret);
		expect(before.toString()).toBe("Specialty coffee. ");
		// Words that only follow Bo's are not yours: Ready goes out for the table as it is.
		const ready = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent === "Ready",
		);
		ready!.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(named("qorpera_update_company_founding")).toEqual([]);
		expect(named("qorpera_set_founder_ready")).toEqual([
			{ p_profile_id: table, p_expected_revision: 4, p_ready: true },
		]);
		// Once his save shows, the box shows the table's words and nothing is tinted.
		presence().tabs([tab({ field: null })]);
		await settle();
		vision = "Specialty coffee. Roasted in Aarhus.";
		await controller!.refresh();
		expect(box().value).toBe(vision);
		expect(tinted()).toBe("");
	});

	it("keeps your own words when Bo writes too, puts his caret where it falls in them, and Ready waits for your save", async () => {
		const { presence, named } = mount(undefined, (name) => {
			if (name === "qorpera_update_company_founding") throw new Error("Failed to fetch");
			return undefined;
		});
		await settle();
		presence().health("connected");
		await settle();
		const field = box();
		field.focus();
		field.value = "Specialty coffee and cake.";
		field.dispatchEvent(new Event("input"));
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ text: "Specialty coffee. Roasted in Aarhus.", caret: 36 }));
		await settle();
		expect(field.value).toBe("Specialty coffee and cake.");
		const layer = container.querySelector<HTMLElement>(".founding-carets")!;
		expect(layer.querySelector("mark")).toBeNull();
		const caret = layer.querySelector<HTMLElement>(".founding-caret")!;
		const before = document.createRange();
		before.setStart(layer, 0);
		before.setEndBefore(caret);
		// His caret at the end of his words stands at the end of yours.
		expect(before.toString()).toBe("Specialty coffee and cake.");
		// Your save fails: Ready does not go out, and your words stay.
		field.blur();
		await vi.advanceTimersByTimeAsync(0);
		expect(named("qorpera_update_company_founding")).toHaveLength(1);
		await controller!.setReady(4, true);
		expect(named("qorpera_set_founder_ready")).toEqual([]);
		expect(field.value).toBe("Specialty coffee and cake.");
	});

	it("keeps your unsaved words yours when another founder's words are the same, and Ready and Start wait", async () => {
		const { presence, named } = mount(undefined, (name) => {
			if (name === "qorpera_update_company_founding") throw new Error("Failed to fetch");
			return undefined;
		});
		await settle();
		presence().health("connected");
		await settle();
		const field = box();
		field.focus();
		field.value = "Specialty coffee and cake.";
		field.dispatchEvent(new Event("input"));
		field.blur();
		await vi.advanceTimersByTimeAsync(0);
		expect(named("qorpera_update_company_founding")).toHaveLength(1);
		// Bo happens to write exactly your words: they are still not on the table, so still yours and unsaved.
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ text: "Specialty coffee and cake.", caret: 26 }));
		await settle();
		expect(field.value).toBe("Specialty coffee and cake.");
		await controller!.setReady(4, true);
		await controller!.start();
		expect(named("qorpera_set_founder_ready")).toEqual([]);
		expect(named("qorpera_start_company_founding")).toEqual([]);
		// His next words do not replace yours.
		presence().live(live({ text: "Specialty coffee and cake. Roasted.", caret: 35 }));
		await settle();
		expect(field.value).toBe("Specialty coffee and cake.");
		// Leaving the field again tries your save again.
		field.focus();
		field.blur();
		await vi.advanceTimersByTimeAsync(0);
		expect(named("qorpera_update_company_founding")).toHaveLength(2);
		expect(named("qorpera_update_company_founding")[1]).toMatchObject({ p_vision: "Specialty coffee and cake." });
	});

	it("keeps a writer's words in the idea box when they move to their role line, for the hold", async () => {
		const { presence } = mount();
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab()]);
		await settle();
		presence().live(live());
		await settle();
		// Bo leaves the idea box for his role line; his idea is on its way to the table.
		presence().tabs([tab({ field: "role" })]);
		await settle();
		presence().live(live({ field: "role", text: "Wholesale.", caret: 10, typing: false, own: false }));
		await settle();
		expect(box().value).toBe("Specialty coffee. Roasted in Aarhus.");
		expect(container.querySelector(".founding-line .founding-caret")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(5000);
		expect(box().value).toBe("Specialty coffee. Roasted in Aarhus.");
		// His save never showed: after the hold the box shows the table's words again.
		await vi.advanceTimersByTimeAsync(1100);
		expect(box().value).toBe("Specialty coffee.");
	});

	it("sends your words and caret as you write, at most every 200 ms, and your last words before you leave", async () => {
		const { handle } = mount();
		await settle();
		const field = box();
		field.focus();
		expect(handle.setState).toHaveBeenLastCalledWith(true, "vision");
		// Untouched, the box's words are the table's, not yours.
		expect(handle.sendLive).toHaveBeenLastCalledWith("vision", "Specialty coffee.", 17, false, false);
		handle.sendLive.mockClear();
		for (const text of ["Specialty coffee. R", "Specialty coffee. Ro", "Specialty coffee. Roa"]) {
			field.value = text;
			field.setSelectionRange(text.length, text.length);
			field.dispatchEvent(new Event("input"));
		}
		expect(handle.sendLive).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200);
		expect(handle.sendLive).toHaveBeenCalledTimes(1);
		expect(handle.sendLive).toHaveBeenLastCalledWith("vision", "Specialty coffee. Roa", 21, true, true);
		// A caret moved by a key right after a word still says you wrote.
		field.value = "Specialty coffee. Roas";
		field.dispatchEvent(new Event("input"));
		field.setSelectionRange(3, 3);
		field.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft" }));
		await vi.advanceTimersByTimeAsync(200);
		expect(handle.sendLive).toHaveBeenLastCalledWith("vision", "Specialty coffee. Roas", 3, true, true);
		// While you stay in the field, your words go again now and then, for anyone who came since.
		handle.sendLive.mockClear();
		await vi.advanceTimersByTimeAsync(5000);
		expect(handle.sendLive).toHaveBeenCalledWith("vision", "Specialty coffee. Roas", 3, false, true);
		// Leaving the field sends what was not sent yet, then says you left.
		field.value = "Specialty coffee. Roast";
		field.dispatchEvent(new Event("input"));
		field.value = "Specialty coffee. Roaste";
		field.dispatchEvent(new Event("input"));
		handle.sendLive.mockClear();
		handle.setState.mockClear();
		field.blur();
		expect(handle.sendLive).toHaveBeenCalledWith("vision", "Specialty coffee. Roaste", 24, true, true);
		expect(handle.setState).toHaveBeenLastCalledWith(true, null);
		expect(handle.sendLive.mock.invocationCallOrder[0]!).toBeLessThan(handle.setState.mock.invocationCallOrder[0]!);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(handle.sendLive).toHaveBeenCalledTimes(1);
		// Your role line goes out the same way.
		const role = container.querySelector<HTMLTextAreaElement>("textarea.founding-role-mine")!;
		role.focus();
		expect(handle.sendLive).toHaveBeenLastCalledWith("role", "", 0, false, false);
	});

	it("never follows words a tab only shows: its caret stands in your box, its words do not", async () => {
		const { presence } = mount();
		await settle();
		presence().health("connected");
		await settle();
		// Bo's box shows words that are not his (another writer's, not saved yet): his caret counts, those words do not.
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ text: "Specialty coffee. Cake.", caret: 18, typing: false, own: false }));
		await settle();
		expect(box().value).toBe("Specialty coffee.");
		expect(controller!.store.get().liveText?.[0]).toMatchObject({ unsaved: false, caret: 18 });
		const layer = container.querySelector<HTMLElement>(".founding-carets")!;
		expect(layer.querySelector("mark")).toBeNull();
		const caret = layer.querySelector<HTMLElement>(".founding-caret")!;
		const before = document.createRange();
		before.setStart(layer, 0);
		before.setEndBefore(caret);
		expect(before.toString()).toBe("Specialty coffee.");
		expect(writingLine().hidden).toBe(true);
	});

	it("takes words only from founders at the table: not an invited person's, not your own other tab's", async () => {
		const { presence } = mount();
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab({ clientId: cyTab, userId: cy }), tab({ clientId: id(952), userId: me })]);
		await settle();
		presence().live(live({ clientId: cyTab, userId: cy }));
		await settle();
		presence().live(live({ clientId: id(952), userId: me }));
		await settle();
		// Nor a name or role longer than its field takes.
		presence().live(live({ field: "name", text: "N".repeat(121), caret: 0 }));
		await settle();
		presence().live(live({ field: "role", text: "R".repeat(301), caret: 0 }));
		await settle();
		expect(controller!.store.get().liveText).toEqual([]);
		expect(box().value).toBe("Specialty coffee.");
		expect(writingLine().hidden).toBe(true);
		expect(controller!.store.get().present).toEqual([{ userId: cy, here: true, writing: false }]);
	});

	it("holds a writer's words a while after they leave the field, until their save shows", async () => {
		let vision = "Specialty coffee.";
		const { presence } = mount(() => wire({ vision, revision: vision === "Specialty coffee." ? 4 : 5 }));
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab()]);
		await settle();
		presence().live(live());
		await settle();
		presence().tabs([tab({ field: null })]);
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		// His caret left with him; his words are still on their way.
		expect(box().value).toBe("Specialty coffee. Roasted in Aarhus.");
		expect(container.querySelector(".founding-carets .founding-caret")).toBeNull();
		await vi.advanceTimersByTimeAsync(1100);
		expect(box().value).toBe("Specialty coffee.");
		// A save that shows takes over at once.
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ text: "Specialty coffee. Roasted.", caret: 26 }));
		await settle();
		presence().tabs([tab({ field: null })]);
		await settle();
		vision = "Specialty coffee. Roasted.";
		await controller!.refresh();
		expect(controller!.store.get().liveText?.[0]?.unsaved).toBe(false);
		expect(box().value).toBe("Specialty coffee. Roasted.");
	});

	it("shows Bo's role line as he writes it, with his caret", async () => {
		const { presence } = mount();
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab({ field: "role" })]);
		await settle();
		presence().live(live({ field: "role", text: "Wholesale and cafés.", caret: 9 }));
		await settle();
		const line = container.querySelector<HTMLElement>(".founding-line")!;
		expect(line.textContent).toBe("BoWholesale and cafés.");
		const caret = line.querySelector<HTMLElement>(".founding-caret")!;
		const before = document.createRange();
		before.setStart(line.lastElementChild!, 0);
		before.setEndBefore(caret);
		expect(before.toString()).toBe("Wholesale");
	});

	it("shows an invited person who is writing and where, and sends nothing of theirs", async () => {
		const { presence, handle } = mount(() => wire({}, "invited"));
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab()]);
		await settle();
		presence().live(live({ caret: 17 }));
		await settle();
		const text = container.querySelector<HTMLElement>("p.founding-vision")!;
		expect(text.hidden).toBe(false);
		expect(text.querySelector("mark")?.textContent).toBe(" Roasted in Aarhus.");
		expect(text.querySelector(".founding-caret")?.textContent).toBe("Bo");
		expect(visibleText(writingLine())).toBe("Bo is writing");
		expect(container.querySelector(".founding-invite")?.hasAttribute("hidden")).toBe(true);
		controller!.noteField("vision");
		controller!.noteLive("vision", "Hello", 5, true, true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(handle.sendLive).not.toHaveBeenCalled();
	});

	it("leaves the topic when the table starts, and never joins again on a cloud without it", async () => {
		let phase = "open";
		const started = {
			startedAt: "2026-10-22T20:00:00Z",
			startedByUserId: bo,
			revision: 4,
			clientStartId: id(2),
			companyReady: false,
			companySetup: "pending",
		};
		const { presence, handle, joined } = mount(() =>
			phase === "open"
				? wire()
				: wire({
						phase: "started",
						vision: "",
						start: started,
						waitingFor: [],
						me: { userId: me, state: "joined", canEdit: false, canManage: false, canStart: false },
					}),
		);
		await settle();
		expect(joined()).toBe(true);
		presence().health("connected");
		await settle();
		phase = "started";
		await controller!.refresh();
		expect(handle.stop).toHaveBeenCalledTimes(1);
		expect(controller!.store.get().live).toBe(false);

		controller!.dispose();
		const other = mount();
		await settle();
		other.presence().health("unavailable");
		await settle();
		vi.mocked(other.api.joinFoundingPresence).mockClear();
		await controller!.refresh();
		expect(other.api.joinFoundingPresence).not.toHaveBeenCalled();
		expect(container.querySelector(".founding-heads-live")).toBeNull();
	});

	it("says it in Danish", async () => {
		setLanguagePreference("da");
		const { presence } = mount();
		await settle();
		presence().health("connected");
		await settle();
		presence().tabs([tab()]);
		await settle();
		presence().live(live());
		await settle();
		expect(visibleText(writingLine())).toBe("Bo skriver");
		expect(visibleText(chip(bo))).toContain("Skriver");
		presence().tabs([tab(), tab({ clientId: cyTab, userId: cy, field: null })]);
		await settle();
		expect(chip(bo).textContent).toContain("Her nu");
	});
});

describe("a founding table on a cloud without its presence", () => {
	const realTimeout = globalThis.setTimeout;
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("works as before: no rings, no writing, nothing sent, and Ready goes out", async () => {
		vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
		const f = fixture();
		const container = document.createElement("div");
		document.body.append(container);
		const calls: string[] = [];
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
			calls.push(name);
			if (name === "qorpera_read_company_founding") return wire();
			if (name === "qorpera_set_founder_ready") return wire({ revision: Number(args.p_expected_revision) });
			throw new Error(`Unexpected RPC ${name}`);
		});
		// The fixture's topic client, watched: it asks the cloud to register this tab, meets PGRST202 and stops for good.
		const join = vi.mocked(f.api.joinFoundingPresence);
		const real = join.getMockImplementation()!;
		const health: string[] = [];
		join.mockImplementation((profileId, listener) =>
			real(profileId, {
				...listener,
				health: (value) => {
					health.push(value);
					listener.health(value);
				},
			}),
		);
		const controller = new FoundingController(f.api, me, table, { currentUserId: () => me });
		const view = new FoundingView(controller);
		container.append(view.el);
		controller.store.subscribe(() => view.update());
		view.update();
		for (let i = 0; i < 400 && !health.includes("unavailable"); i++)
			await new Promise((done) => realTimeout(done, 5));
		expect(health).toEqual(["connecting", "unavailable"]);
		await settle();
		expect(controller.store.get().live).not.toBe(true);
		expect(container.querySelector(".founding-heads-live")).toBeNull();
		expect(container.querySelector<HTMLElement>(".founding-writing")?.hidden).toBe(true);
		const field = container.querySelector<HTMLTextAreaElement>("textarea.founding-vision")!;
		field.focus();
		field.value = "Specialty coffee. Roasted.";
		field.dispatchEvent(new Event("input"));
		field.value = "Specialty coffee.";
		field.dispatchEvent(new Event("input"));
		field.blur();
		await controller.setReady(4, true);
		// Only the table's own calls: nothing about presence reached this cloud's table calls.
		expect(calls.filter((name) => name !== "qorpera_read_company_founding")).toEqual(["qorpera_set_founder_ready"]);
		await controller.refresh();
		expect(join).toHaveBeenCalledTimes(1);
		controller.dispose();
		container.remove();
	});
});

describe("carets and new words", () => {
	it("puts a caret at the same words, or where words the other text lacks would begin", () => {
		expect(caretIn("abc", 2, "abc")).toBe(2);
		// Words added after the caret, before it, and around it.
		expect(caretIn("abc", 1, "abcdef")).toBe(1);
		expect(caretIn("xyzabc", 4, "abc")).toBe(1);
		expect(caretIn("ab NEW cd", 6, "ab cd")).toBe(3);
		expect(caretIn("ab NEW cd", 9, "ab cd")).toBe(5);
		// Never between the two halves of one character.
		expect(caretIn("a😀b", 2, "a😀b")).toBe(1);
		expect(caretIn("a😀b", 9, "a😀")).toBe(3);
	});

	it("finds the words one text adds to another", () => {
		expect(newWords("Coffee.", "Coffee. Cake.")).toEqual({ start: 7, end: 13 });
		expect(newWords("Coffee.", "Coffee.")).toBeUndefined();
		expect(newWords("Coffee and cake.", "Coffee cake.")).toBeUndefined();
		expect(newWords("ab", "a😀b")).toEqual({ start: 1, end: 3 });
	});
});
