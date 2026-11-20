// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { parseEvent } from "../src/cloud/parse.ts";
import {
	foldText,
	type TranscriptItem,
	type TranscriptMessage,
	type TranscriptPeerLink,
	unaskedGroups,
} from "../src/cloud/transcript.ts";
import type { RunWake } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const at = (n: number) => new Date(Date.parse("2026-11-20T08:00:00Z") + n * 60_000).toISOString();
const asked: TranscriptMessage = {
	kind: "member",
	id: id(70),
	sequence: 1,
	text: "How is the website coming?",
	attachmentCount: 0,
	authorUserId: userA.id,
	createdAt: at(0),
};
const say = (n: number, text: string, wokenBy?: RunWake, run = n): TranscriptMessage => ({
	kind: "agent",
	id: id(70 + n),
	sequence: n,
	text,
	attachmentCount: 0,
	phase: "final",
	runId: id(200 + run),
	...(wokenBy ? { wokenBy } : {}),
	createdAt: at(n),
});
const link = (n: number): TranscriptPeerLink => ({
	kind: "peer_link",
	id: id(70 + n),
	sequence: n,
	direction: "in",
	counterpartStaffId: id(60),
	pairSessionId: id(61),
	createdAt: at(n),
});
const reply = say(2, "The first version is ready. Take a look.", "room");
const update = say(4, "Webdesign has your brief. They add the hero animation next.", "agent");
const result = say(6, "**Three versions** are ready for you.\n\nEach keeps the portrait.", "agent");
const report = say(7, "The weekly numbers are in the folder.", "routine");

describe("what a member did not ask for", () => {
	it("is every message of a run that a coworker, a worker, a machine or a routine woke, grouped while nothing stands between", () => {
		const items: TranscriptItem[] = [
			asked,
			reply,
			link(3),
			update,
			link(5),
			result,
			report,
			{ ...asked, id: id(99) },
			link(9),
		];
		const groups = unaskedGroups(items);
		expect([...groups]).toEqual([
			[
				id(73),
				{ items: [id(73), update.id, id(75), result.id, report.id], messages: [update.id, result.id, report.id] },
			],
		]);
		expect(unaskedGroups([asked, reply, say(3, "Hello, I am new here.", "first-run"), say(4, "Old.")]).size).toBe(0);
		expect([...unaskedGroups([update, reply, result]).keys()]).toEqual([update.id, result.id]);
		expect(unaskedGroups([update, result], (item) => item.id === update.id).get(result.id)?.messages).toEqual([
			result.id,
		]);
		const asks = {
			kind: "interaction",
			id: id(98),
			sequence: 9,
			actorUserId: userA.id,
			runId: update.runId,
		} as TranscriptItem;
		expect(unaskedGroups([update, asks]).size).toBe(0);
		expect(
			unaskedGroups([
				{ ...update, erased: true },
				{ ...result, held: true },
			]).size,
		).toBe(0);
	});

	it("shows as its first sentence, in plain words, cut where it gets long", () => {
		expect(foldText("Webdesign has your brief. They add the hero animation next.")).toBe("Webdesign has your brief.");
		expect(foldText("  Three versions\n are ready  ")).toBe("Three versions are ready");
		expect(foldText(`${"long ".repeat(40)}.`)).toHaveLength(140);
		expect(foldText("Version 2.1 is live! More soon.")).toBe("Version 2.1 is live!");
	});

	it("is read from the event's run_wake, and only for a run's event and a kind the web knows", () => {
		const event = {
			session_id: session.sessionId,
			sequence: 1,
			event_id: id(1),
			event_type: "message",
			actor_user_id: userA.id,
			body: {},
			previous_hash: null,
			event_hash: "a".repeat(64),
			created_at: at(0),
		};
		const run = {
			execution_kind: "run",
			execution_id: id(2),
			execution_claimant_id: id(2),
			runner_assignment_id: id(3),
		};
		expect(parseEvent({ ...event, ...run, run_wake: "agent" }).runWake).toBe("agent");
		expect(parseEvent({ ...event, ...run, run_wake: "something-new" }).runWake).toBeUndefined();
		expect(parseEvent({ ...event, ...run }).runWake).toBeUndefined();
		expect(parseEvent({ ...event, run_wake: "agent" }).runWake).toBeUndefined();
	});
});

function setup(room = false) {
	stubFigureMotion();
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const opened = room ? { ...session, executionScope: { roomId: id(79) } } : { ...session, staffAgentId: staff.id };
	company.store.set({ team, staff: [staff], sessions: [opened], loading: false });
	company.conversation(session.sessionId, false).set({ loading: false });
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	cleanup.push(() => {
		view.dispose();
		company.stop();
	});
	const show = async (items: TranscriptItem[]) => {
		company
			.conversation(session.sessionId, false)
			.set({ loading: false, projection: { items, hiddenCount: 0, lastSequence: items.length } });
		view.update();
		await settle();
	};
	const rows = () =>
		[...view.el.querySelectorAll<HTMLElement>(".messages-log > article.message, .messages-log > .thread-fold")].map(
			(el) =>
				el.classList.contains("thread-fold")
					? `fold:${el.textContent}`
					: [...el.querySelectorAll(".bubble")].map((bubble) => bubble.textContent).join(" "),
		);
	const fold = (n = 0) => view.el.querySelectorAll<HTMLButtonElement>(".thread-fold")[n]!;
	return { view, show, rows, fold };
}

describe("the folded line in an agent's thread", () => {
	it("stands for one unasked message as its first sentence, and opens to the whole message and closes again", async () => {
		const f = setup();
		await f.show([asked, reply, update]);
		expect(f.rows()).toEqual([
			"How is the website coming?",
			"The first version is ready. Take a look.",
			"fold:Webdesign has your brief.",
		]);
		expect(f.fold().getAttribute("aria-expanded")).toBe("false");
		f.fold().click();
		await settle();
		expect(f.rows().slice(2)).toEqual([
			"fold:Hide update",
			"Webdesign has your brief. They add the hero animation next.",
		]);
		expect(f.fold().getAttribute("aria-expanded")).toBe("true");
		f.fold().click();
		await settle();
		expect(f.rows().slice(2)).toEqual(["fold:Webdesign has your brief."]);
	});

	it("gathers several in a row, with the newest one's words, and stays open when another arrives", async () => {
		const f = setup();
		await f.show([asked, reply, link(3), update, link(5), result]);
		expect(f.rows().slice(2)).toEqual(["fold:2 updatesThree versions are ready for you."]);
		expect(f.view.el.querySelectorAll(".messages-log .peer-link, .messages-log [class*=peer]")).toHaveLength(0);
		await f.show([asked, reply, link(3), update, link(5), result, report]);
		expect(f.rows().slice(2)).toEqual(["fold:3 updatesThe weekly numbers are in the folder."]);
		f.fold().click();
		await settle();
		expect(f.rows().slice(2)).toEqual([
			"fold:Hide 3 updates",
			"Webdesign has your brief. They add the hero animation next.",
			"Three versions are ready for you. Each keeps the portrait.",
			"The weekly numbers are in the folder.",
		]);
		await f.show([asked, reply, link(3), update, link(5), result, report, say(8, "And the backup ran.", "routine")]);
		expect(f.rows()).toHaveLength(7);
		expect(f.rows()[2]).toBe("fold:Hide 4 updates");
	});

	it("leaves what the member asked for, a first greeting and a message with no wake as they are, and starts anew after them", async () => {
		const f = setup();
		const greeting = say(3, "Hello, I am your new designer.", "first-run");
		await f.show([
			asked,
			reply,
			greeting,
			say(11, "From before the field."),
			update,
			{ ...asked, id: id(99) },
			result,
		]);
		expect(f.rows()).toEqual([
			"How is the website coming?",
			"The first version is ready. Take a look.",
			"Hello, I am your new designer.",
			"From before the field.",
			"fold:Webdesign has your brief.",
			"How is the website coming?",
			"fold:Three versions are ready for you.",
		]);
	});

	it("folds nothing in a group chat", async () => {
		const f = setup(true);
		await f.show([asked, update, result]);
		expect(f.view.el.querySelector(".thread-fold")).toBeNull();
		expect(f.view.el.querySelectorAll("article.message")).toHaveLength(3);
	});
});
