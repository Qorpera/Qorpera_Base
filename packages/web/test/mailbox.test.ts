// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import { type MailboxManage, renderMailbox } from "../src/app/views/mailbox.ts";
import type { EventHook } from "../src/cloud/event-hooks.ts";
import type { WebRoutine, WebRoutineDraft } from "../src/cloud/routines.ts";
import type { HostedProfileRole } from "../src/cloud/types.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import { setLanguagePreference, setTimeZonePreference } from "../src/ui/preferences.ts";
import { fixture, id, profileA, scrolledTo, session, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";
import {
	ADDRESS,
	accountsFake,
	ada,
	at,
	bo,
	cofounder,
	connections,
	digitalPostConnected,
	letter,
	letterFolder,
	letterId,
	letterIndex,
	letterMarkdown,
	type MailFake,
	mailFake,
	received,
	summary,
	thread,
	waitingSend,
} from "./mail-fixtures.ts";

/* The rebuilt Mailbox (views/mailbox.ts): the company's mail as a mail app's inbox, from the member mail read (the fake
 * in test/mail-fixtures.ts). The sends waiting for a person come first and are answered on their line; a thread opens
 * with its older messages folded, and Reply, Reply all and Forward under them; an answer goes as the member's own
 * email in the thread, or its words go to an agent as the member's own message, with the email's outside words as
 * quotes; Sent, Addresses, Write and search; what a viewer may not do is not drawn. */

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	location.hash = "";
	Reflect.deleteProperty(document, "visibilityState");
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A waiting send as the waiting call lists it. */
function waitingItem(reviewId: string, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		reviewId,
		thread: thread(1),
		sessionId: session.sessionId,
		address: ADDRESS.address,
		staffAgent: { staffAgentId: ada.id, name: "Ada" },
		to: ["sender1@outside.example"],
		subject: "Re: Subject 1",
		snippet: "Paid today.",
		createdAt: at(0),
		...more,
	};
}

/** The Mailbox on screen, drawn again on every change. `setup` fills the mail before it is read; `folder` is the
 * company folder its Digital Post letters are read from. */
async function mailbox(setup: (fake: MailFake) => void, role: HostedProfileRole = "owner", folder?: FolderFake) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const me = { userId: userA.id, email: "a@example.invalid", displayName: "Account A", role, joinedAt: timestamp };
	controller.store.set({
		loading: false,
		staff: [cofounder, ada, bo],
		sessions: [session],
		team: {
			...team,
			role,
			capabilities: { ...team.capabilities, write: role !== "viewer", authorize: role === "owner" },
			members: [me],
		},
	});
	cleanup.push(() => controller.stop());
	const fake = mailFake(f);
	fake.addresses = [ADDRESS];
	setup(fake);
	const accounts = accountsFake();
	const reader = new CompanyMail(
		controller,
		f.cloud,
		accounts,
		(state) => controller.store.set({ mail: state }),
		folder ? () => folder.folder : undefined,
	);
	cleanup.push(() => reader.dispose());
	await reader.open();
	const main = h("main");
	document.body.append(main);
	// The address and Digital Post calls behind Addresses: a mailbox for each address the mail lists, Digital Post not
	// connected.
	const hooks: EventHook[] = fake.addresses.map((address, n) => ({
		id: id(950 + n),
		name: `mail-${String(address.address).split("@")[0]}`,
		purpose: String(address.address).split("@")[0]!,
		proof: "mail",
		status: "active",
		email: String(address.address),
		createdAt: timestamp,
	}));
	// The routines that start on mail to a mailbox, as the routine list gives them: each address's own (`routines`), and
	// those the page makes. Who answers an address follows them, as the cloud's address read does.
	// The cloud's clock for them: each change is later than the one before it.
	let changes = 0;
	const stamp = () => new Date(Date.parse(timestamp) + ++changes * 1000).toISOString();
	const listening: WebRoutine[] = fake.addresses.flatMap((address, n) =>
		(address.routines as { routineId: string; title: string; staffAgentId: string }[]).map(
			(routine) =>
				({
					routineId: routine.routineId,
					clientRoutineId: routine.routineId,
					title: routine.title,
					staffAgentId: routine.staffAgentId,
					status: "active",
					updatedAt: stamp(),
					triggers: [{ id: "file", kind: "listener", source: "event", hookId: id(950 + n), timeZone: "UTC" }],
				}) as WebRoutine,
		),
	);
	/** What a test turns: the routines that stay paused when they are resumed (they wait for a login), and what else
	 * happens in the cloud as a new routine is saved (another member's save, or a routine that does not start). */
	const cloud = { stuck: new Set<string>(), saved: (_made: WebRoutine) => {} };
	const answered = () => {
		fake.addresses = fake.addresses.map((address) => {
			const hook = hooks.find((each) => each.email === address.address);
			const active = listening.filter(
				(routine) =>
					routine.status === "active" &&
					routine.triggers.some((trigger) => "hookId" in trigger && trigger.hookId === hook?.id),
			);
			return {
				...address,
				routines: active.map(({ routineId, title, staffAgentId }) => ({ routineId, title, staffAgentId })),
				handledBy: [...new Set(active.map((routine) => routine.staffAgentId))].map((staffAgentId) => ({
					staffAgentId,
					name: [cofounder, ada, bo].find((agent) => agent.id === staffAgentId)?.displayName,
				})),
			};
		});
	};
	const manage: MailboxManage = {
		routines: {
			list: vi.fn(async () => listening.map((routine) => ({ ...routine }))),
			save: vi.fn(async (draft: WebRoutineDraft) => {
				const made = {
					routineId: id(700 + listening.length),
					clientRoutineId: draft.clientRoutineId,
					title: draft.title,
					staffAgentId: draft.staffAgentId,
					status: "active",
					updatedAt: stamp(),
					triggers: [draft.trigger],
				} as WebRoutine;
				listening.push(made);
				cloud.saved(made);
				answered();
				return "saved" as const;
			}),
			setEnabled: vi.fn(async (routine: { routineId: string }, _account: unknown, enabled: boolean) => {
				const kept = listening.find((each) => each.routineId === routine.routineId);
				if (kept) {
					kept.status = enabled && !cloud.stuck.has(kept.routineId) ? "active" : "paused";
					kept.updatedAt = stamp();
				}
				answered();
			}),
		},
		accounts: vi.fn(async () => connections),
		hooks: {
			list: vi.fn(async () => [...hooks]),
			createHook: vi.fn(),
			createMailbox: vi.fn(async (name: string, purpose: string) => {
				const made: EventHook = {
					id: id(950 + hooks.length),
					name: `mail-${name}`,
					purpose,
					proof: "mail",
					status: "active",
					email: `${name}@acme.example`,
					createdAt: timestamp,
				};
				hooks.push(made);
				return made;
			}),
			setStatus: vi.fn(),
		},
		digitalPost: {
			read: vi.fn(async () => ({
				connected: false,
				status: "disconnected" as const,
				letters: 0,
				waitingForFolder: 0,
				held: 0,
			})),
			save: vi.fn(),
			disconnect: vi.fn(),
		},
	};
	const draw = () => renderMailbox(main, controller, "mailbox", { manage: () => manage });
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { f, controller, fake, main, manage, accounts, routines: { listening, cloud, stamp, answered } };
}

const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const calls = (fake: MailFake, fn: string) => fake.calls.filter((call) => call.fn === fn).map((call) => call.args);
const button = (root: ParentNode, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
	);
/** A row of the open menu, by its label: a row starts with a picture, and a face's initials are text too. */
const menuRow = (label: string) =>
	[...openMenu()!.el.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
		(row) => row.querySelector(".context-menu-label")?.textContent === label,
	)!;
const lines = (main: HTMLElement) => [...main.querySelectorAll<HTMLElement>(".mailbox-row")];
const tab = (main: HTMLElement, name: string) => button(main.querySelector(".mailbox-tabs")!, name)?.click();
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
/** The controls under `root` that can be used, each by its label or else by its focus key. */
const usable = (root: ParentNode) =>
	[...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea")]
		.filter((each) => !each.disabled)
		.map((each) => each.getAttribute("aria-label") ?? each.getAttribute("data-focus-key"));

describe("the Inbox", () => {
	it("lists the sends waiting for a person first, then every other thread on one line each", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [
				summary(1, { state: "waiting", messages: 3 }),
				summary(2, { snippet: "Can you deliver on Friday?", unread: true }),
				summary(3, { state: "handled", direction: "sent", snippet: "Yes, we can.", messages: 2 }),
			];
			mail.waiting = [waitingItem(id(901))];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(3));
		expect(texts(main, ".mailbox-section")).toEqual(["Waiting for you", "Everything else"]);
		const [waiting, fresh, answered] = lines(main);
		expect(waiting!.classList.contains("is-waiting")).toBe(true);
		expect(waiting!.querySelector(".mailbox-who")?.textContent).toBe("Sender 13");
		expect(texts(waiting!, ".mailbox-line > span")).toEqual([
			"Waiting for you",
			"to sender1@outside.example",
			"Re: Subject 1",
			" — Ada: Paid today.",
		]);
		expect(texts(waiting!, ".mailbox-actions button")).toEqual(["Don't send", "Send"]);
		// A new thread: bold while unread, its agent grey until it handles it, the start of its text after the subject.
		expect(fresh!.classList.contains("is-unread")).toBe(true);
		expect(texts(fresh!, ".mailbox-line .mailbox-state")).toEqual(["New"]);
		expect(fresh!.querySelector(".mailbox-subject")?.textContent).toBe("Subject 2");
		expect(fresh!.querySelector(".mailbox-snippet")?.textContent).toBe(" — Can you deliver on Friday?");
		expect(fresh!.querySelector(".mailbox-handler")?.classList.contains("is-new")).toBe(true);
		expect(fresh!.querySelector(".mailbox-handler")?.getAttribute("title")).toBe("Ada hasn't handled it yet");
		// The company wrote last: the agent is named with the sender, and its words follow its name.
		expect(answered!.querySelector(".mailbox-who")?.textContent).toBe("Sender 3, Ada2");
		expect(answered!.querySelector(".mailbox-snippet")?.textContent).toBe(" — Ada: Yes, we can.");
		expect(answered!.querySelector(".mailbox-handler")?.getAttribute("title")).toBe("Ada handles it");
		expect(answered!.querySelector(".mailbox-actions")?.children).toHaveLength(0);
		// Outside words carry the mark that says so; the Inbox tab counts what waits.
		expect(fresh!.querySelector(".mailbox-subject")?.getAttribute("title")).toBe("From outside the company");
		expect(main.querySelector(".mailbox-tab .mailbox-count")?.textContent).toBe("1");
	});

	it("answers a waiting send on its line through its card, and the line leaves", async () => {
		const { main, f, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting" })];
			mail.waiting = [waitingItem(id(901))];
		});
		const answer = vi.spyOn(f.api, "answerActionReview").mockImplementation(async (reviewId, _input, given) => {
			fake.waiting = [];
			return { reviewId, answer: given, inputId: id(950), savedRuleId: null, woke: true };
		});
		await vi.waitFor(() => expect(button(main, "Send")).toBeDefined());
		button(main, "Send")!.click();
		await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(881),
			sponsorVersion: 1,
		});
		await vi.waitFor(() => expect(main.querySelector(".mailbox-section")).toBeNull());
		expect(lines(main)).toHaveLength(1);
		expect(lines(main)[0]!.classList.contains("is-waiting")).toBe(false);
	});

	it("narrows the lines to what the search finds, and says when nothing does", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { snippet: "About the cake" }), summary(2), summary(3, { fromName: "Mette Holm" })];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(3));
		const search = main.querySelector<HTMLInputElement>(".mailbox-search input")!;
		// What the words find is read from its top, wherever the list was left.
		const list = () => main.querySelector<HTMLElement>(".mailbox-scroll")!;
		scrolledTo(list(), 60);
		type(search, "cake");
		expect(texts(main, ".mailbox-row .mailbox-subject")).toEqual(["Subject 1"]);
		expect(list().scrollTop).toBe(0);
		type(search, "mette");
		expect(texts(main, ".mailbox-row .mailbox-subject")).toEqual(["Subject 3"]);
		// The field keeps its words and the focus when the page draws again.
		const field = main.querySelector<HTMLInputElement>(".mailbox-search input")!;
		field.focus();
		type(field, "nothing like it");
		expect(main.querySelector<HTMLInputElement>(".mailbox-search input")?.value).toBe("nothing like it");
		expect(document.activeElement).toBe(main.querySelector(".mailbox-search input"));
		expect(main.querySelector(".mailbox-none")?.textContent).toBe("No mail matches.");
	});

	it("shows account mail only as account mail for its site, and who used the account", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [
				summary(1, {
					subject: undefined,
					account: { site: "wolt.example", lastUsedBy: ada.id, lastUsedAt: at(5) },
					state: "handled",
				}),
			];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(lines(main)[0]!.querySelector(".mailbox-who")?.textContent).toBe("Account mail");
		expect(texts(lines(main)[0]!, ".mailbox-line > span")).toEqual(["wolt.example", " — Ada used the account"]);
	});

	it("says the address is ready while nothing has arrived, and that there is none when the company has none", async () => {
		const { main } = await mailbox(() => {});
		await vi.waitFor(() => expect(main.querySelector(".mailbox-empty h1")).not.toBeNull());
		expect(main.querySelector(".mailbox-empty h1")?.textContent).toBe("hello@acme.example is ready");
		expect(main.querySelector(".mailbox-empty p")?.textContent).toBe(
			"Nothing has arrived yet. Ada answers what comes in.",
		);
		const none = await mailbox((mail) => {
			mail.addresses = [];
		});
		await vi.waitFor(() =>
			expect(none.main.querySelector(".mailbox-empty h1")?.textContent).toBe("The company has no email address yet"),
		);
		// An owner makes the first address right here; the mail is read again, and the page opens.
		expect(none.main.querySelector(".mailbox-tabs")).toBeNull();
		await vi.waitFor(() => expect(button(none.main, "Add mailbox")).toBeDefined());
		button(none.main, "Add mailbox")!.click();
		const form = none.main.querySelector<HTMLFormElement>("#hook-form-mailbox")!;
		// The name is all the form asks to be typed; who answers the address is picked on its chip.
		expect([...form.querySelectorAll("input")].map((field) => field.getAttribute("aria-label"))).toEqual([
			"Mailbox name",
		]);
		const answers = () => none.main.querySelector<HTMLButtonElement>("[data-focus-key='add-answerer']")!;
		const picked = () => answers().querySelector(".mailbox-writer-name")?.textContent;
		expect(picked()).toBe("Choose who answers");
		answers().click();
		expect(texts(openMenu()!.el, ".context-menu-label")).toEqual(["Nobody", "Co-Founder", "Ada", "Bo"]);
		menuRow("Bo").click();
		expect(picked()).toBe("Bo");
		expect(document.activeElement).toBe(answers());
		type(none.main.querySelector('input[aria-label="Mailbox name"]')!, "hello");
		none.fake.addresses = [{ ...ADDRESS, handledBy: [], routines: [] }];
		none.main.querySelector<HTMLFormElement>("#hook-form-mailbox")!.requestSubmit();
		await vi.waitFor(() =>
			expect(none.manage.hooks.createMailbox).toHaveBeenCalledWith("hello", "hello", expect.anything()),
		);
		await vi.waitFor(() => expect(none.main.querySelector(".mailbox-tabs")).not.toBeNull());
		// The new address goes to the agent picked: a routine of Bo's that starts on its mail.
		await vi.waitFor(() => expect(none.manage.routines!.save).toHaveBeenCalledTimes(1));
		expect(vi.mocked(none.manage.routines!.save).mock.calls[0]?.[0]).toMatchObject({
			staffAgentId: bo.id,
			title: "Answer email to hello@acme.example",
			trigger: { kind: "listener", source: "event", hookId: id(950), only: ["mail.received"] },
		});
		await vi.waitFor(() =>
			expect(none.main.querySelector(".mailbox-toast")?.textContent).toBe("Bo answers hello@acme.example"),
		);
	});
});

describe("a thread", () => {
	it("folds the older messages to one line, opens the newest, and lets its waiting send be sent", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting", messages: 2 })];
			mail.waiting = [waitingItem(id(901))];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					received(3, { text: "We would like lunch for 40." }),
					{
						kind: "sent",
						mailId: id(700),
						fromAddress: ADDRESS.address,
						to: ["sender1@outside.example"],
						cc: [],
						subject: "Re: Subject 1",
						text: "Gladly. Plates too?",
						status: "sent",
						at: at(2),
						staffAgent: { staffAgentId: ada.id, name: "Ada" },
						attachments: [],
					},
				],
				more: false,
				waiting: [waitingSend(id(901))],
			};
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-message")).toHaveLength(2));
		expect(calls(fake, "qorpera_member_mail_thread").at(-1)).toMatchObject({ p_thread: thread(1) });
		const [first, second] = main.querySelectorAll<HTMLElement>(".mailbox-message");
		expect(first!.classList.contains("is-folded")).toBe(true);
		expect(first!.querySelector(".mailbox-snippet")?.textContent).toBe("We would like lunch for 40.");
		expect(second!.querySelector(".mailbox-text-body")?.textContent).toBe("Gladly. Plates too?");
		expect(second!.querySelector(".mailbox-status")?.textContent).toBe("Sent");
		// A folded message opens; a received one says it came from outside.
		first!.querySelector<HTMLButtonElement>(".mailbox-fold")!.click();
		const opened = main.querySelector<HTMLElement>(".mailbox-message")!;
		expect(opened.classList.contains("is-folded")).toBe(false);
		expect(opened.querySelector(".mailbox-text-body")?.getAttribute("title")).toBe("From outside the company");
		// The send that waits, with its answers.
		const draft = main.querySelector<HTMLElement>(".mailbox-draft")!;
		expect(draft.querySelector("strong")?.textContent).toBe("Ada wants to send this");
		expect(draft.querySelector(".mailbox-text-body")?.textContent).toBe("Paid today.");
		expect(texts(draft, ".mailbox-draft-actions button")).toEqual(["Send", "Don't send"]);
		// Back to the Inbox.
		button(main, "Back to Inbox")!.click();
		expect(main.querySelector(".mailbox-thread")).toBeNull();
	});

	it("shows an account thread's mail only as who used the account, with nothing to answer", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: undefined, account: { site: "wolt.example" }, state: "handled" })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					received(1, {
						subject: undefined,
						text: undefined,
						account: { site: "wolt.example", lastUsedBy: ada.id, lastUsedAt: at(5) },
					}),
				],
				more: false,
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-message.is-account")).not.toBeNull());
		expect(main.querySelector(".mailbox-thread-head h1")?.textContent).toBe("Account mail · wolt.example");
		expect(main.querySelector(".mailbox-message.is-account")?.textContent).toContain("Ada used the account");
		expect(main.querySelector(".mailbox-text-body")).toBeNull();
		expect(main.querySelector(".mailbox-answers")).toBeNull();
	});
});

/** The answer being written at the foot of the open thread. */
const reply = (main: HTMLElement) => main.querySelector<HTMLFormElement>(".mailbox-reply-box")!;
/** Opens the list's first thread once its answers show. */
async function openFirst(main: HTMLElement): Promise<void> {
	await vi.waitFor(() => expect(lines(main)).not.toHaveLength(0));
	lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
	await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
}
/** Opens the list's first thread, starts a reply and gives it to the agent `name` with `words`. */
async function answerAs(main: HTMLElement, name: string, words: string): Promise<void> {
	await openFirst(main);
	button(main, "Reply")!.click();
	reply(main).querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
	menuRow(name).click();
	type(reply(main).querySelector("textarea")!, words);
	reply(main).requestSubmit();
}

describe("answering in a thread", () => {
	// Jonas, 12 Nov 2026: "you should get similar answer/reply buttons as in the real gmail/outlook app, not the
	// chatcomposer to tell other agents what to reply".
	it("replies as the member themself, in the thread, to who sent the email", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1)];
		});
		await openFirst(main);
		// Under the messages: the answers a mail app has, and no line to an agent. The email went to the company alone,
		// so there is nobody else to reply to.
		expect(texts(main, ".mailbox-answers button")).toEqual(["Reply", "Forward"]);
		expect(main.querySelector(".mailbox-composer")).toBeNull();
		button(main, "Reply")!.click();
		// The answer opens in their place: to the sender, written by the member, from the thread's address.
		expect(main.querySelector(".mailbox-answers")).toBeNull();
		expect(reply(main).getAttribute("aria-label")).toBe("Reply");
		expect(texts(reply(main), ".mailbox-chip-text")).toEqual(["sender1@outside.example"]);
		expect(reply(main).querySelector(".mailbox-writer-name")?.textContent).toBe("You");
		expect(main.querySelector(".mailbox-reply > .person-avatar")).not.toBeNull();
		expect(reply(main).querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		expect(document.activeElement).toBe(reply(main).querySelector("textarea"));
		expect(reply(main).querySelector("textarea")?.placeholder).toBe("Write your reply");
		// With no text it is held, and says why.
		reply(main).requestSubmit();
		expect(reply(main).querySelector(".mailbox-write-error")?.textContent).toBe("The email needs its text");
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		type(reply(main).querySelector("textarea")!, "Yes, Friday works.\n");
		expect(reply(main).querySelector(".mailbox-write-error")).toBeNull();
		reply(main).requestSubmit();
		expect(button(reply(main), "Sending")?.disabled).toBe(true);
		expect(button(reply(main), "Discard")?.disabled).toBe(true);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).toBeNull());
		// One email, as an answer to the message: the cloud puts it in the thread.
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([
			{
				p_environment_id: profileA.environmentId,
				p_request: {
					sendId: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
					from: "hello@acme.example",
					to: ["sender1@outside.example"],
					subject: "Re: Subject 1",
					text: "Yes, Friday works.",
					replyTo: { kind: "received", id: "delivery-1" },
				},
			},
		]);
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your reply is on its way");
		// It stands in the thread as the member's own, and the answers are back under it, with the keyboard on Reply.
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-message")).toHaveLength(2));
		const sent = [...main.querySelectorAll<HTMLElement>(".mailbox-message")].at(-1)!;
		expect(sent.querySelector(".mailbox-from strong")?.textContent).toBe("You");
		expect(sent.querySelector(".mailbox-text-body")?.textContent).toBe("Yes, Friday works.");
		expect(sent.querySelector(".mailbox-status")?.textContent).toBe("Sending");
		expect(document.activeElement).toBe(button(main, "Reply"));
	});

	it("replies to all: everyone else the email went to, the company's own addresses left out", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: "Re: Lunch" })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					received(1, {
						subject: "Re: Lunch",
						to: ["Hello <hello@acme.example>", "Bo Berg <bo@outside.example>", "SENDER1@outside.example"],
						cc: ["carla@outside.example", "hello+orders@acme.example", "undisclosed-recipients:;"],
					}),
				],
				more: false,
				waiting: [],
			};
		});
		await openFirst(main);
		expect(texts(main, ".mailbox-answers button")).toEqual(["Reply", "Reply all", "Forward"]);
		button(main, "Reply all")!.click();
		expect(reply(main).getAttribute("aria-label")).toBe("Reply all");
		const rows = [...reply(main).querySelectorAll<HTMLElement>(".mailbox-write-to")];
		expect(rows.map((row) => row.querySelector(".mailbox-write-label")?.textContent)).toEqual(["To", "Cc"]);
		expect(texts(rows[0]!, ".mailbox-chip-text")).toEqual(["sender1@outside.example", "bo@outside.example"]);
		expect(texts(rows[1]!, ".mailbox-chip-text")).toEqual(["carla@outside.example"]);
		// One more copy, typed and left in the field: it goes with the chips.
		type(rows[1]!.querySelector("input")!, "dan@outside.example");
		type(reply(main).querySelector("textarea")!, "See you all there.");
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).toBeNull());
		// The subject says "Re:" once.
		expect(calls(fake, "qorpera_send_member_mail").map((call) => call.p_request)).toEqual([
			expect.objectContaining({
				to: ["sender1@outside.example", "bo@outside.example"],
				cc: ["carla@outside.example", "dan@outside.example"],
				subject: "Re: Lunch",
				text: "See you all there.",
				replyTo: { kind: "received", id: "delivery-1" },
			}),
		]);
		// The member's own email is now the thread's newest: a reply to it follows it up, to who it went to.
		await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
		button(main, "Reply")!.click();
		expect(texts(reply(main), ".mailbox-chip-text")).toEqual(["sender1@outside.example", "bo@outside.example"]);
		type(reply(main).querySelector("textarea")!, "One more thing.");
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(calls(fake, "qorpera_send_member_mail")).toHaveLength(2));
		expect(calls(fake, "qorpera_send_member_mail")[1]?.p_request).toMatchObject({
			to: ["sender1@outside.example", "bo@outside.example"],
			subject: "Re: Lunch",
			replyTo: { kind: "sent", id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
		});
		expect(calls(fake, "qorpera_send_member_mail")[1]?.p_request).not.toHaveProperty("cc");
	});

	// Review of #1716, round 1: an email from an address nobody reads got its answer there.
	it("answers where the email asks its answers to go, in both modes, and its sender when it asks nowhere else", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1), summary(2)];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					received(1, {
						fromAddress: "no-reply@vendor.example",
						// A name beside the address, the company's own address, and the same address again.
						replyTo: ["Support <support@vendor.example>", "hello@acme.example", "SUPPORT@vendor.example"],
						to: [ADDRESS.address, "bo@outside.example", "support@vendor.example"],
						cc: ["no-reply@vendor.example"],
					}),
				],
				more: false,
				waiting: [],
			};
		});
		await openFirst(main);
		button(main, "Reply")!.click();
		expect(texts(reply(main), ".mailbox-chip-text")).toEqual(["support@vendor.example"]);
		button(reply(main), "Discard")!.click();
		// To all: where it asks first, then everyone else it went to; its sender has only the copy it had.
		button(main, "Reply all")!.click();
		const rows = [...reply(main).querySelectorAll<HTMLElement>(".mailbox-write-to")];
		expect(texts(rows[0]!, ".mailbox-chip-text")).toEqual(["support@vendor.example", "bo@outside.example"]);
		expect(texts(rows[1]!, ".mailbox-chip-text")).toEqual(["no-reply@vendor.example"]);
		// An email that asks for nowhere else is answered to its sender.
		button(main, "Back to Inbox")!.click();
		lines(main)[1]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
		button(main, "Reply")!.click();
		expect(texts(reply(main), ".mailbox-chip-text")).toEqual(["sender2@outside.example"]);
	});

	// Review of #1716, round 1: with the thread's mailbox paused, the answer left from another one, and a retry after a
	// lost answer was a new email.
	it("sends an answer from its thread's address, whatever happens to that address meanwhile", async () => {
		const orders = { ...ADDRESS, address: "orders@acme.example", handledBy: [], routines: [] };
		const { main, fake, controller } = await mailbox((mail) => {
			// The thread's own mailbox is paused from the start, and another one is in use.
			mail.addresses = [orders, { ...ADDRESS, status: "paused" }];
			mail.threads = [summary(1)];
		});
		await openFirst(main);
		button(main, "Reply")!.click();
		expect(reply(main).querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		type(reply(main).querySelector("textarea")!, "Yes.");
		// The cloud refuses a paused mailbox, and says so: no other address stands in.
		fake.sendError = { message: "The mailbox is paused; resume it to send from it", code: "0A000" };
		reply(main).requestSubmit();
		await vi.waitFor(() =>
			expect(reply(main).querySelector(".mailbox-write-error")?.textContent).toBe(
				"The mailbox is paused; resume it to send from it",
			),
		);
		// It is resumed, and then removed from what the page knows: the answer is still the same email, from the same
		// address, under the same send id.
		const mail = controller.store.get().mail!;
		controller.store.set({
			mail: { ...mail, addresses: mail.addresses.filter((each) => each.address === orders.address) },
		});
		expect(reply(main).querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		fake.sendError = undefined;
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).toBeNull());
		const requests = calls(fake, "qorpera_send_member_mail").map(
			(call) => call.p_request as { sendId: string; from: string },
		);
		expect(requests.map((request) => request.from)).toEqual(["hello@acme.example", "hello@acme.example"]);
		expect(requests[1]?.sendId).toBe(requests[0]?.sendId);
	});

	it("forwards a message as a new email of the member's own, its text under their words", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1)];
		});
		await openFirst(main);
		button(main, "Forward")!.click();
		expect(reply(main).getAttribute("aria-label")).toBe("Forward");
		// Nobody has it yet, so the keyboard is on who it goes to; an agent sends no email on, so it has no Writer chip.
		expect(texts(reply(main), ".mailbox-chip-text")).toEqual([]);
		expect(document.activeElement).toBe(reply(main).querySelector("[data-focus-key='reply-to']"));
		expect(reply(main).querySelector(".mailbox-writer")).toBeNull();
		const text = reply(main).querySelector("textarea")!;
		expect(text.value.split("\n").slice(0, 8)).toEqual([
			"",
			"",
			"---------- Forwarded message ----------",
			"From: Sender 1 <sender1@outside.example>",
			expect.stringMatching(/^Date: .+/),
			"Subject: Subject 1",
			"To: hello@acme.example",
			"",
		]);
		expect(text.value.endsWith("Hello from sender 1.")).toBe(true);
		reply(main).requestSubmit();
		expect(reply(main).querySelector(".mailbox-write-error")?.textContent).toBe("Add who the email goes to");
		type(reply(main).querySelector<HTMLInputElement>("[data-focus-key='reply-to']")!, "boss@outside.example ");
		type(text, `For you.${text.value}`);
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).toBeNull());
		const [request] = calls(fake, "qorpera_send_member_mail").map(
			(call) => call.p_request as Record<string, unknown>,
		);
		expect(request).toMatchObject({ to: ["boss@outside.example"], subject: "Fwd: Subject 1" });
		expect(request).not.toHaveProperty("replyTo");
		expect(String(request?.text).startsWith("For you.\n\n---------- Forwarded message ----------\n")).toBe(true);
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your email is on its way");
	});

	it("gives a reply to an agent from its Writer chip, quoting the email's subject and sender", async () => {
		const { main, controller, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: "Invoice 42", fromName: "Jane", state: "handled" })];
		});
		const open = vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await openFirst(main);
		button(main, "Reply")!.click();
		reply(main).querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
		menuRow("Ada").click();
		// The agent answers whoever it finds right: the answer keeps its text alone, and says who writes it.
		expect(reply(main).querySelector(".mailbox-writer-name")?.textContent).toBe("Ada");
		expect(main.querySelector(".mailbox-reply > .figure")).not.toBeNull();
		expect(reply(main).querySelector(".mailbox-write-to")).toBeNull();
		expect(reply(main).querySelector("textarea")?.placeholder).toBe("What should it say?");
		expect(reply(main).querySelector(".mailbox-write-foot .mailbox-muted")?.textContent).toBe(
			"Ada writes and sends it",
		);
		type(reply(main).querySelector("textarea")!, "Say we pay on Friday.");
		expect(button(reply(main), "Ask Ada to write it")?.type).toBe("submit");
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: ada.id }));
		const draft = "Please answer the email «Invoice 42» from «Jane»: Say we pay on Friday.";
		expect(send).toHaveBeenCalledWith(session.sessionId, draft);
		const quote = (words: string) => ({
			start: draft.indexOf(words),
			end: draft.indexOf(words) + words.length,
			source: "mail",
			ref: thread(1),
		});
		expect(controller.draftQuotes(session.sessionId)).toEqual([quote("Invoice 42"), quote("Jane")]);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada is writing it"));
		// The member sent no email themself, and the answer has left the thread's foot.
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		expect(main.querySelector(".mailbox-reply")).toBeNull();
		expect(texts(main, ".mailbox-answers button")).toEqual(["Reply", "Forward"]);
	});

	it("leaves a note that can't go from here waiting in the agent's thread", async () => {
		const { main, controller } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "handled" })];
		});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(false);
		// Something is drafted there already: the note is added after it, and nothing is sent from here.
		controller.conversation(session.sessionId).set({ draft: "Earlier words" });
		await answerAs(main, "Ada", "Answer kindly.");
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`));
		expect(send).not.toHaveBeenCalled();
		expect(controller.conversation(session.sessionId).get().draft).toContain("Answer kindly.");
	});

	it("keeps an answer with its thread while the member reads elsewhere, until it is sent or let go", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1), summary(2)];
		});
		await openFirst(main);
		button(main, "Reply")!.click();
		type(reply(main).querySelector("textarea")!, "Half an answer");
		// Another thread has no answer of its own.
		button(main, "Back to Inbox")!.click();
		lines(main)[1]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
		expect(main.querySelector(".mailbox-reply")).toBeNull();
		// Back in the first, it is as it was left.
		button(main, "Back to Inbox")!.click();
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).not.toBeNull());
		expect(reply(main).querySelector("textarea")?.value).toBe("Half an answer");
		// The bin lets it go: the answers are back, with the keyboard on the one it was.
		button(reply(main), "Discard")!.click();
		expect(main.querySelector(".mailbox-reply")).toBeNull();
		expect(document.activeElement).toBe(button(main, "Reply"));
		button(main, "Reply")!.click();
		expect(reply(main).querySelector("textarea")?.value).toBe("");
	});

	it("keeps an answer the cloud did not take, back in its thread, and sends it again as the same email", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1)];
		});
		await openFirst(main);
		button(main, "Reply")!.click();
		type(reply(main).querySelector("textarea")!, "Yes.");
		let release = () => {};
		fake.sendHold = new Promise((resolve) => {
			release = resolve;
		});
		fake.sendError = { message: "The mailbox is paused; resume it to send from it", code: "0A000" };
		reply(main).requestSubmit();
		// The member goes back to the Inbox while it is on its way; refused, it is in front of them again.
		button(main, "Back to Inbox")!.click();
		expect(main.querySelector(".mailbox-thread")).toBeNull();
		release();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-write-error")?.textContent).toBe(
				"The mailbox is paused; resume it to send from it",
			),
		);
		expect(reply(main).querySelector("textarea")?.value).toBe("Yes.");
		expect(document.activeElement).toBe(button(reply(main), "Send"));
		// Sent again as it stands it is the same email; changed, it is a new one.
		fake.sendHold = undefined;
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(calls(fake, "qorpera_send_member_mail")).toHaveLength(2));
		await vi.waitFor(() => expect(button(reply(main), "Send")?.disabled).toBe(false));
		type(reply(main).querySelector("textarea")!, "Yes, gladly.");
		fake.sendError = undefined;
		reply(main).requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-reply")).toBeNull());
		const ids = calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { sendId: string }).sendId);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
	});
});

describe("Sent, Addresses and Write", () => {
	it("lists in Sent the threads the company wrote last, from the threads call's own filter", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1), summary(2, { direction: "sent", state: "handled", snippet: "Done." })];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(2));
		tab(main, "Sent");
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(calls(fake, "qorpera_member_mail_threads").at(-1)).toMatchObject({
			p_request: { direction: "sent" },
		});
		expect(lines(main)[0]!.querySelector(".mailbox-who")?.textContent).toBe("To:Sender 2");
		expect(main.querySelector(".mailbox-tab[aria-selected='true']")?.textContent).toBe("Sent");
	});

	// Jonas, 12 Nov 2026: "don't like the UX of giving an agent an email - should be more intuitive".
	it("lists each address once with who answers it, and gives it to an agent or takes it from one in one step", async () => {
		const { main, controller, manage } = await mailbox(() => {});
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		// One line an address: its name, who answers it on a chip, how much came, and its buttons.
		await vi.waitFor(() => expect(main.querySelectorAll(".hook-card")).toHaveLength(1));
		const card = () => main.querySelector<HTMLElement>(".hook-card")!;
		const chip = () => card().querySelector<HTMLButtonElement>(".mailbox-answerer")!;
		const named = () => chip().querySelector(".mailbox-writer-name")?.textContent;
		const said = () => card().querySelector(".mailbox-address-agent > .mailbox-muted")?.textContent;
		const toast = () => main.querySelector(".mailbox-toast")?.textContent;
		const press = (name: string) => {
			chip().click();
			menuRow(name).click();
		};
		expect(card().querySelector(".settings-copy strong")?.textContent).toBe("hello@acme.example");
		expect(main.querySelector(".mailbox-address")).toBeNull();
		expect([said(), named()]).toEqual(["Answered by", "Ada"]);
		expect(card().querySelector(".mailbox-week")?.textContent).toBe("12");
		expect(texts(card(), ".connection-actions button")).toEqual(["Pause", "Remove"]);
		// The chip opens the agents, each one a box to tick: those who answer it are ticked.
		chip().click();
		expect(texts(openMenu()!.el, ".context-menu-label")).toEqual(["Co-Founder", "Ada", "Bo"]);
		expect(menuRow("Ada").getAttribute("role")).toBe("menuitemcheckbox");
		expect(menuRow("Ada").getAttribute("aria-checked")).toBe("true");
		expect(menuRow("Bo").getAttribute("aria-checked")).toBe("false");
		menuRow("Bo").click();
		// While it is on its way the chip names the agents as they will be, and waits.
		expect([said(), named()]).toEqual(["Setting it up", "Ada and Bo"]);
		expect(chip().disabled).toBe(true);
		await vi.waitFor(() => expect(toast()).toBe("Bo answers hello@acme.example too"));
		// Bo got a routine of his own that starts on the address's mail: the member's own save, on their model account.
		// Ada's answering did not change, and no word went to the Co-Founder.
		expect(vi.mocked(manage.routines!.save).mock.calls).toEqual([
			[
				{
					clientRoutineId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					staffAgentId: bo.id,
					title: "Answer email to hello@acme.example",
					prompt: expect.stringContaining("Read each email that arrives at hello@acme.example"),
					trigger: {
						id: "file",
						kind: "listener",
						source: "event",
						hookId: id(950),
						only: ["mail.received"],
						timeZone: expect.any(String),
						replyPolicy: "optional",
					},
					effort: "low",
				},
				expect.objectContaining({ connectionId: id(880) }),
				expect.any(String),
			],
		]);
		expect(manage.routines!.setEnabled).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect([said(), named()]).toEqual(["Answered by", "Ada and Bo"]);
		expect(chip().disabled).toBe(false);
		expect(document.activeElement).toBe(chip());
		// Ada's tick off: her routine stops, and Bo answers alone.
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada no longer answers hello@acme.example"));
		expect(vi.mocked(manage.routines!.setEnabled).mock.calls).toEqual([
			[expect.objectContaining({ routineId: id(801) }), undefined, false, expect.any(String)],
		]);
		expect(named()).toBe("Bo");
		// On again: she takes up the routine she had, and no second one is made.
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada answers hello@acme.example too"));
		expect(manage.routines!.save).toHaveBeenCalledTimes(1);
		expect(vi.mocked(manage.routines!.setEnabled).mock.calls.at(-1)).toEqual([
			expect.objectContaining({ routineId: id(801) }),
			expect.objectContaining({ connectionId: id(880) }),
			true,
			expect.any(String),
		]);
		expect(named()).toBe("Ada and Bo");
		// Both off: nobody answers it, and the chip asks again.
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada no longer answers hello@acme.example"));
		press("Bo");
		await vi.waitFor(() => expect(toast()).toBe("Bo no longer answers hello@acme.example"));
		expect([said(), named()]).toEqual([undefined, "Choose who answers"]);
		expect(chip().classList.contains("is-current")).toBe(false);
		// The first agent on an address answers it alone.
		press("Co-Founder");
		await vi.waitFor(() => expect(toast()).toBe("Co-Founder answers hello@acme.example"));
		// The company's addresses are made, paused and removed here, and Digital Post connected.
		expect(button(main, "Add mailbox")).toBeDefined();
		expect(main.querySelector(".mailbox-addresses .mailbox-manage [data-hooks='mailbox']")).not.toBeNull();
		expect(main.querySelector(".mailbox-addresses .mailbox-manage [data-hooks='webhook']")).toBeNull();
		expect(main.querySelector(".mailbox-addresses .mailbox-manage .digital-post")).not.toBeNull();
	});

	// Review of #1719, rounds 1 and 2: a handover in steps could stop half way. One agent's answering is one thing now,
	// and what the cloud holds after decides what is said.
	it("says why an address could not be given to an agent, and goes by what the cloud holds when an answer is lost", async () => {
		const { main, manage, routines } = await mailbox(() => {});
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		await vi.waitFor(() => expect(main.querySelector(".hook-card")).not.toBeNull());
		const chip = () => main.querySelector<HTMLButtonElement>(".hook-card .mailbox-answerer")!;
		const named = () => chip().querySelector(".mailbox-writer-name")?.textContent;
		const said = () => main.querySelector(".hook-card .mailbox-error")?.textContent;
		const toast = () => main.querySelector(".mailbox-toast")?.textContent;
		const press = (name: string) => {
			chip().click();
			menuRow(name).click();
		};
		const lost =
			<A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
			async (...args: A): Promise<R> => {
				await call(...args);
				throw new Error("Failed to fetch");
			};
		const save = vi.mocked(manage.routines!.save);
		const setEnabled = vi.mocked(manage.routines!.setEnabled);
		const list = vi.mocked(manage.routines!.list);
		expect(named()).toBe("Ada");
		// None of the member's model accounts can pay for work that starts on its own: nothing is written.
		vi.mocked(manage.accounts!).mockResolvedValueOnce({ ...connections, connections: [] });
		press("Bo");
		await vi.waitFor(() =>
			expect(said()).toBe(
				"An agent answers email by itself on one of your own model accounts, and none of yours can pay for that. Connect one in Settings → AI subscriptions.",
			),
		);
		expect(save).not.toHaveBeenCalled();
		expect(named()).toBe("Ada");
		expect(toast()).toBeUndefined();
		// The save is refused: its reason is said.
		save.mockRejectedValueOnce(new Error("The company is paused."));
		press("Bo");
		await vi.waitFor(() => expect(said()).toBe("The company is paused."));
		expect(named()).toBe("Ada");
		// The save goes, but the routine is not at work after it: Bo is not said to answer.
		routines.cloud.saved = (made) => {
			made.status = "paused";
		};
		press("Bo");
		await vi.waitFor(() =>
			expect(said()).toBe("Bo's routine for this address did not start. Bo's routines say why."),
		);
		expect(named()).toBe("Ada");
		expect(toast()).toBeUndefined();
		routines.cloud.saved = () => {};
		// Nothing of this touched Ada's routine.
		expect(setEnabled).not.toHaveBeenCalled();
		// An answer that is lost: Bo's routine was taken up again in the cloud, though the page heard nothing. What the
		// cloud holds decides, and the next thing said is true.
		setEnabled.mockImplementationOnce(lost(setEnabled.getMockImplementation()!));
		press("Bo");
		await vi.waitFor(() => expect(toast()).toBe("Bo answers hello@acme.example too"));
		expect(said()).toBeUndefined();
		expect(named()).toBe("Ada and Bo");
		// The same for a stop whose answer is lost.
		setEnabled.mockImplementationOnce(lost(setEnabled.getMockImplementation()!));
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada no longer answers hello@acme.example"));
		expect(said()).toBeUndefined();
		expect(named()).toBe("Bo");
		// The cloud cannot be read after a stop: the page says so and claims nothing; the line is as the mail says.
		list.mockImplementationOnce(list.getMockImplementation()!).mockRejectedValueOnce(new Error("Failed to fetch"));
		press("Bo");
		await vi.waitFor(() => expect(said()).toBe("Failed to fetch"));
		expect(named()).toBe("Choose who answers");
	});

	// Review of #1719, round 1: a routine taken up again may stay paused, waiting for a login.
	it("gives the agent a new routine when the one it had stays paused, and never says it answers before it does", async () => {
		const { main, manage, routines } = await mailbox((mail) => {
			mail.addresses = [{ ...ADDRESS, handledBy: [], routines: [] }];
		});
		// Ada answered the address once: her routine is paused, and waits for a login only its own page moves.
		routines.listening.push({
			routineId: id(801),
			clientRoutineId: id(801),
			title: "Morning mail",
			staffAgentId: ada.id,
			status: "paused",
			updatedAt: routines.stamp(),
			triggers: [{ id: "file", kind: "listener", source: "event", hookId: id(950), timeZone: "UTC" }],
		} as WebRoutine);
		routines.cloud.stuck.add(id(801));
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		await vi.waitFor(() => expect(main.querySelector(".hook-card")).not.toBeNull());
		const chip = () => main.querySelector<HTMLButtonElement>(".hook-card .mailbox-answerer")!;
		chip().click();
		menuRow("Ada").click();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada answers hello@acme.example"),
		);
		// The old routine was tried first and stayed paused; the new one is hers, and at work.
		expect(vi.mocked(manage.routines!.setEnabled).mock.calls).toEqual([
			[
				expect.objectContaining({ routineId: id(801) }),
				expect.objectContaining({ connectionId: id(880) }),
				true,
				expect.any(String),
			],
		]);
		expect(manage.routines!.save).toHaveBeenCalledTimes(1);
		expect(routines.listening.map((routine) => [routine.staffAgentId, routine.status])).toEqual([
			[ada.id, "paused"],
			[ada.id, "active"],
		]);
		expect(chip().querySelector(".mailbox-writer-name")?.textContent).toBe("Ada");
	});

	it("keeps one routine when another member gives the address to the same agent at the same moment", async () => {
		const theirs = (n: number, updatedAt: string) =>
			({
				routineId: id(n),
				clientRoutineId: id(n),
				title: "Answer email to hello@acme.example",
				staffAgentId: ada.id,
				status: "active",
				updatedAt,
				triggers: [{ id: "file", kind: "listener", source: "event", hookId: id(950), timeZone: "UTC" }],
			}) as WebRoutine;
		const { main, manage, routines } = await mailbox((mail) => {
			mail.addresses = [{ ...ADDRESS, handledBy: [], routines: [] }];
		});
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		await vi.waitFor(() => expect(main.querySelector(".hook-card")).not.toBeNull());
		const chip = () => main.querySelector<HTMLButtonElement>(".hook-card .mailbox-answerer")!;
		const toast = () => main.querySelector(".mailbox-toast")?.textContent;
		const press = (name: string) => {
			chip().click();
			menuRow(name).click();
		};
		const stops = () => vi.mocked(manage.routines!.setEnabled).mock.calls.map((call) => [call[0].routineId, call[2]]);
		const atWork = () =>
			routines.listening.filter((routine) => routine.status === "active").map((routine) => routine.routineId);
		// The other member's save is the later one: it stays, and this page's own routine stops. Ada answers once.
		routines.cloud.saved = () => {
			routines.listening.push(theirs(990, routines.stamp()));
		};
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada answers hello@acme.example"));
		expect(stops()).toEqual([[id(700), false]]);
		expect(atWork()).toEqual([id(990)]);
		expect(main.querySelector(".hook-card .mailbox-error")).toBeNull();
		// Off, then the other way round: the other member's save is the earlier one, so this page's stays and theirs
		// stops. Ada's routine from before stays paused when it is taken up, so she gets a new one here.
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada no longer answers hello@acme.example"));
		vi.mocked(manage.routines!.setEnabled).mockClear();
		routines.cloud.stuck.add(id(700)).add(id(990));
		routines.cloud.saved = (made) => {
			routines.listening.push(theirs(991, new Date(Date.parse(made.updatedAt) - 500).toISOString()));
		};
		press("Ada");
		await vi.waitFor(() => expect(toast()).toBe("Ada answers hello@acme.example"));
		expect(stops()).toEqual([
			[id(990), true],
			[id(991), false],
		]);
		expect(atWork()).toEqual([id(702)]);
	});

	it("builds the address cards again for a company opened again, and in a new time zone or language", async () => {
		const { f, main, controller, manage } = await mailbox(() => {});
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		await vi.waitFor(() => expect(button(main, "Add mailbox")).toBeDefined());
		const first = main.querySelector(".mailbox-manage .hooks");
		// The company is left and opened again: a new controller for the same company, the old one stopped.
		const again = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => again.stop());
		again.store.set(controller.store.get());
		controller.stop();
		renderMailbox(main, again, "mailbox", { manage: () => manage });
		await vi.waitFor(() => expect(button(main, "Add mailbox")).toBeDefined());
		expect(main.querySelector(".mailbox-manage .hooks")).not.toBe(first);
		expect(manage.hooks.list).toHaveBeenCalledTimes(2);
		// A new time zone builds them again, so their times are in it.
		const before = main.querySelector(".mailbox-manage .hooks");
		setTimeZonePreference("Asia/Tokyo");
		cleanup.push(() => setTimeZonePreference("system"));
		renderMailbox(main, again, "mailbox", { manage: () => manage });
		await vi.waitFor(() => expect(button(main, "Add mailbox")).toBeDefined());
		expect(main.querySelector(".mailbox-manage .hooks")).not.toBe(before);
		// A new language builds them again in it.
		setLanguagePreference("da");
		cleanup.push(() => setLanguagePreference("system"));
		renderMailbox(main, again, "mailbox", { manage: () => manage });
		await vi.waitFor(() => expect(button(main, "Tilføj postkasse")).toBeDefined());
	});

	// Jonas, 10 Nov 2026: "It should have no agent owning it by default when the user clicks write manually - that
	// indicates he is writing it until an agent is assigned".
	it("starts a new email as the member's own, and asks the agent picked from the Writer chip to write it", async () => {
		const { main, controller, fake } = await mailbox(() => {});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const chip = () => panel().querySelector<HTMLButtonElement>(".mailbox-writer")!;
		const writer = () => chip().querySelector(".mailbox-writer-name")?.textContent;
		// Nobody has it yet: one chip, the member's own. The email is theirs to write and send, from the company's
		// address.
		expect(panel().querySelectorAll(".mailbox-pick")).toHaveLength(1);
		expect(writer()).toBe("You");
		expect(chip().querySelector(".person-avatar")).not.toBeNull();
		expect(chip().classList.contains("is-current")).toBe(false);
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		expect(texts(panel(), ".mailbox-write-label")).toEqual(["Writer", "To", "Subject"]);
		expect(panel().querySelector("textarea")!.placeholder).toBe("Write your email");
		expect(button(panel(), "Send")).toBeDefined();
		expect(panel().querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		// A name typed before the agent is picked is not cut at its space: it stays the name it was typed as.
		type(panel().querySelector("input")!, "Nordlys Energi");
		expect(panel().querySelector(".mailbox-chip")).toBeNull();
		type(panel().querySelector("textarea")!, "Ask when the new price starts.");
		chip().click();
		expect(send).not.toHaveBeenCalled();
		const menu = openMenu()!;
		expect(texts(menu.el, ".context-menu-label")).toEqual(["You", "Co-Founder", "Ada", "Bo"]);
		// Each row starts with its writer's picture; the one who has the email ends in the check.
		expect(texts(menu.el, "[aria-checked='true'] .context-menu-label")).toEqual(["You"]);
		expect(menuRow("You").firstElementChild?.classList.contains("person-avatar")).toBe(true);
		expect(menuRow("You").lastElementChild?.classList.contains("icon")).toBe(true);
		expect(menuRow("Ada").firstElementChild?.classList.contains("figure")).toBe(true);
		expect(menuRow("Ada").lastElementChild?.classList.contains("context-menu-label")).toBe(true);
		expect(chip().getAttribute("aria-expanded")).toBe("true");
		menuRow("Ada").click();
		expect(openMenu()).toBeUndefined();
		expect(writer()).toBe("Ada");
		expect(chip().classList.contains("is-current")).toBe(true);
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		expect(panel().querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		expect(panel().querySelector("textarea")!.placeholder).toBe("What should it say?");
		// An agent writes the subject itself. Who it goes to is as the member left it: the name still typed, in the same
		// field, which now says it takes a name too.
		expect(texts(panel(), ".mailbox-write-label")).toEqual(["Writer", "To"]);
		expect(panel().querySelector(".mailbox-chip")).toBeNull();
		expect(panel().querySelector("input")!.value).toBe("Nordlys Energi");
		expect(panel().querySelector("input")!.placeholder).toBe("Name or email address");
		expect(document.activeElement).toBe(chip());
		expect(button(panel(), "Ask Ada to write it")).toBeDefined();
		panel().requestSubmit();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				"Please write an email to Nordlys Energi from hello@acme.example: Ask when the new price starts.",
			),
		);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada is writing it");
		// The agent sends it: nothing went as the member's own email.
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		// The next email is nobody's again.
		button(main, "Write")!.click();
		expect(writer()).toBe("You");
	});

	// Jonas, 10 Nov 2026: "is it selecting/locking any recievers when i type the mail of the person I want to email".
	it("turns each address typed for the member's own email into a chip, and marks one that is no address", async () => {
		const { main } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		// The keyboard starts in the field, which says what it takes until it has a chip.
		expect(document.activeElement).toBe(to());
		expect(to().placeholder).toBe("Email address");
		// The space after an address ends it, and so does a comma or a semicolon; what stands after is still being
		// typed.
		type(to(), "anna@outside.example ");
		expect(chips()).toEqual(["anna@outside.example"]);
		expect(to().value).toBe("");
		expect(to().placeholder).toBe("");
		type(to(), "bo@outside.example,carl@outside.");
		expect(chips()).toEqual(["anna@outside.example", "bo@outside.example"]);
		expect(to().value).toBe("carl@outside.");
		// Enter ends one too, and sends nothing.
		type(to(), "carl@outside.example");
		const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		to().dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(chips()).toEqual(["anna@outside.example", "bo@outside.example", "carl@outside.example"]);
		expect(panel().querySelector(".mailbox-write-error")).toBeNull();
		// The same address twice is one chip.
		type(to(), "ANNA@outside.example;");
		expect(chips()).toHaveLength(3);
		// A name's space ends nothing: its next word follows. Ended by a comma it is one chip, which is no email
		// address: it is marked, and says so.
		type(to(), "Nordlys Energi");
		expect(chips()).toHaveLength(3);
		expect(to().value).toBe("Nordlys Energi");
		type(to(), "Nordlys Energi,");
		expect(chips()).toHaveLength(4);
		expect(to().value).toBe("");
		const wrong = () => panel().querySelector<HTMLElement>(".mailbox-chip.is-invalid")!;
		expect(wrong().querySelector(".mailbox-chip-text")?.textContent).toBe("Nordlys Energi");
		expect(wrong().title).toBe("Not an email address");
		expect(panel().querySelectorAll(".mailbox-chip.is-invalid")).toHaveLength(1);
		// Backspace in the empty field takes the last chip away.
		to().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
		expect(chips()).toEqual(["anna@outside.example", "bo@outside.example", "carl@outside.example"]);
		// Leaving the field ends what is typed too. A chip's own button takes that chip, and the field has the keyboard.
		type(to(), "jonas@gmaill");
		panel().querySelector("textarea")!.focus();
		await vi.waitFor(() => expect(chips()).toHaveLength(4));
		expect(to().value).toBe("");
		expect(wrong().querySelector(".mailbox-chip-text")?.textContent).toBe("jonas@gmaill");
		button(panel(), "Remove jonas@gmaill")!.click();
		expect(document.activeElement).toBe(to());
		button(panel(), "Remove bo@outside.example")!.click();
		expect(chips()).toEqual(["anna@outside.example", "carl@outside.example"]);
		expect(document.activeElement).toBe(to());
		// A pasted list becomes a chip for each of its entries; the name beside an address is left out.
		const paste = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
			clipboardData: { getData: () => "Dan Holm <dan@outside.example>; mailto:eva@outside.example" },
		});
		to().dispatchEvent(paste);
		expect(paste.defaultPrevented).toBe(true);
		expect(chips()).toEqual([
			"anna@outside.example",
			"carl@outside.example",
			"dan@outside.example",
			"eva@outside.example",
		]);
		// Shut and opened again, the email is as it was left.
		main.querySelector<HTMLButtonElement>(".mailbox-write-head .mailbox-icon")!.click();
		button(main, "Write")!.click();
		expect(chips()).toHaveLength(4);
	});

	it("makes a chip of every entry of a pasted list, and marks the ones that are no address", async () => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		/** Pastes `text` into the field, and says whether the page took it (else the field does, as typing). */
		const paste = (text: string) => {
			const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
				clipboardData: { getData: () => text },
			});
			to().dispatchEvent(event);
			return event.defaultPrevented;
		};
		// An entry that is no address is not dropped beside one that is: it is a chip that says so, and it holds the
		// email back.
		expect(paste("anna@example.com, bo@gmaill")).toBe(true);
		expect(chips()).toEqual(["anna@example.com", "bo@gmaill"]);
		expect(texts(panel(), ".mailbox-chip.is-invalid .mailbox-chip-text")).toEqual(["bo@gmaill"]);
		expect(to().value).toBe("");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		expect(panel().querySelector(".mailbox-write-error")?.textContent).toBe("bo@gmaill is not an email address");
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		button(panel(), "Remove bo@gmaill")!.click();
		// A name written beside its address is left out, with a comma of its own too; a line is an entry.
		expect(paste('"Holm, Dan" <dan@outside.example>\nEva Berg\teva@outside.example')).toBe(true);
		expect(chips()).toEqual(["anna@example.com", "dan@outside.example", "eva@outside.example"]);
		// A piece of an address, or a name alone, is typed on as the field takes it.
		expect(paste("gmaill")).toBe(false);
		expect(paste("Nordlys Energi")).toBe(false);
		expect(chips()).toHaveLength(3);
		// Pasted onto what is typed, the two are read as one.
		type(to(), "carl@");
		to().setSelectionRange(5, 5);
		expect(paste("outside.example")).toBe(true);
		expect(chips()).toEqual([
			"anna@example.com",
			"dan@outside.example",
			"eva@outside.example",
			"carl@outside.example",
		]);
		expect(to().value).toBe("");
	});

	it("sends an entry to the address it points at alone, whatever the name beside it says", async () => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		const paste = (text: string) =>
			to().dispatchEvent(
				Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
					clipboardData: { getData: () => text },
				}),
			);
		const give = (name: string) => {
			panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
			menuRow(name).click();
		};
		// A name that is an address itself is still the name: nobody at it gets the email.
		paste('"old@example.com" <new@example.com>');
		expect(chips()).toEqual(["new@example.com"]);
		// So with no quotes around it, and with a remark in round brackets; an entry that points at what is no address is
		// kept whole, and says so.
		paste("was@example.com <anna@example.com>, bo@example.com (before: bo@old.example), Carl <carl@gmaill>");
		expect(chips()).toEqual(["new@example.com", "anna@example.com", "bo@example.com", "Carl <carl@gmaill>"]);
		expect(texts(panel(), ".mailbox-chip.is-invalid .mailbox-chip-text")).toEqual(["Carl <carl@gmaill>"]);
		button(panel(), "Remove Carl <carl@gmaill>")!.click();
		// Typed, an entry is read the same way.
		type(to(), '"dan@old.example" <dan@example.com>,');
		expect(chips()).toEqual(["new@example.com", "anna@example.com", "bo@example.com", "dan@example.com"]);
		expect(to().value).toBe("");
		// And so is one typed while an agent has the email; back with the member, the chips are as they were made.
		give("Ada");
		type(to(), "eva@old.example <eva@example.com>,");
		give("You");
		const all = ["new@example.com", "anna@example.com", "bo@example.com", "dan@example.com", "eva@example.com"];
		expect(chips()).toEqual(all);
		expect(to().value).toBe("");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { to: string[] }).to)).toEqual([
			all,
		]);
	});

	// Review of #1650, round 3: an address in a quoted name, or in a remark with a comma, got the email too.
	it.each([
		["typed", '"Former <old@example.com>" <new@example.com>'],
		["typed while an agent had it", '"Former <old@example.com>" <new@example.com>'],
		["pasted", "New <new@example.com> (formerly, old@example.com)"],
	])("never sends to an address that stands in a quoted name or a remark (%s)", async (how, entry) => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const give = (name: string) => {
			panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
			menuRow(name).click();
		};
		if (how === "pasted") {
			to().dispatchEvent(
				Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
					clipboardData: { getData: () => entry },
				}),
			);
		} else {
			if (how !== "typed") give("Ada");
			type(to(), entry);
			to().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			if (how !== "typed") give("You");
		}
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["new@example.com"]);
		expect(to().value).toBe("");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { to: string[] }).to)).toEqual([
			["new@example.com"],
		]);
	});

	it("reads a quoted name and a remark whole, and marks an entry that does not say who it goes to", async () => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		const wrong = () => texts(panel(), ".mailbox-chip.is-invalid .mailbox-chip-text");
		const enter = () =>
			to().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		/** Pastes `text` into the field, and says whether the page took it (else the field does, as typing). */
		const paste = (text: string) =>
			!to().dispatchEvent(
				Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
					clipboardData: { getData: () => text },
				}),
			);
		// The comma in a quoted name ends nothing, also while the name is still open.
		type(to(), '"Holm,');
		expect(chips()).toEqual([]);
		expect(to().value).toBe('"Holm,');
		type(to(), '"Holm, Anna" <anna@example.com>,');
		expect(chips()).toEqual(["anna@example.com"]);
		expect(to().value).toBe("");
		// A typed remark is kept beside its address, whole: it is nobody, and it says so.
		type(to(), "bo@example.com (formerly old@example.com ),");
		expect(chips()).toEqual(["anna@example.com", "bo@example.com", "(formerly old@example.com )"]);
		expect(wrong()).toEqual(["(formerly old@example.com )"]);
		button(panel(), "Remove (formerly old@example.com )")!.click();
		// A quote left open runs to the end: what stands in it is no entry of its own. And the space after an address
		// ends it only while nothing after it has a mark, which may make that address the name.
		type(to(), 'carl@example.com "Former <old@example.com>, more@example.com');
		expect(chips()).toHaveLength(2);
		expect(to().value).toBe('carl@example.com "Former <old@example.com>, more@example.com');
		enter();
		expect(chips()).toEqual([
			"anna@example.com",
			"bo@example.com",
			"carl@example.com",
			'"Former <old@example.com>, more@example.com',
		]);
		expect(wrong()).toEqual(['"Former <old@example.com>, more@example.com']);
		button(panel(), 'Remove "Former <old@example.com>, more@example.com')!.click();
		type(to(), "was@example.com <dan@example.com>");
		expect(chips()).toHaveLength(3);
		enter();
		expect(chips()).toEqual(["anna@example.com", "bo@example.com", "carl@example.com", "dan@example.com"]);
		// Pasted, a remark holds its remarks and its commas, and a quoted name its semicolon and an open bracket.
		expect(
			paste(
				'eva@example.com (was (until 2024, old@example.com) there); "Holm; Finn (old@example.com" <finn@example.com>',
			),
		).toBe(true);
		expect(chips().slice(4)).toEqual(["eva@example.com", "finn@example.com"]);
		// A quoted text is a name also when it is all of its entry, and so is a remark: each is kept as it stands, and
		// says it is no address, whatever it holds.
		expect(paste('"gry@example.com","hans@example.com"')).toBe(true);
		expect(chips().slice(6)).toEqual(['"gry@example.com"', '"hans@example.com"']);
		expect(wrong()).toEqual(['"gry@example.com"', '"hans@example.com"']);
		button(panel(), 'Remove "gry@example.com"')!.click();
		button(panel(), 'Remove "hans@example.com"')!.click();
		type(to(), '"old@example.com"');
		enter();
		expect(wrong()).toEqual(['"old@example.com"']);
		button(panel(), 'Remove "old@example.com"')!.click();
		expect(paste("ida@example.com, (old@example.com)")).toBe(true);
		expect(chips().slice(6)).toEqual(["ida@example.com", "(old@example.com)"]);
		expect(wrong()).toEqual(["(old@example.com)"]);
		button(panel(), "Remove (old@example.com)")!.click();
		// An entry that points at two addresses, or has one more after the one it points at, does not say who it goes
		// to: it is one marked chip, as it stands, and none of its addresses is a recipient.
		expect(paste("Former <old@example.com> <new@example.com>")).toBe(false);
		type(to(), "Former <old@example.com> <new@example.com>, Jon <jon@example.com> old@example.com,");
		expect(wrong()).toEqual(["Former <old@example.com> <new@example.com>", "Jon <jon@example.com> old@example.com"]);
		expect(to().value).toBe("");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		expect(panel().querySelector(".mailbox-write-error")?.textContent).toBe(
			"Former <old@example.com> <new@example.com> is not an email address",
		);
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		button(panel(), "Remove Former <old@example.com> <new@example.com>")!.click();
		button(panel(), "Remove Jon <jon@example.com> old@example.com")!.click();
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { to: string[] }).to)).toEqual([
			[
				"anna@example.com",
				"bo@example.com",
				"carl@example.com",
				"dan@example.com",
				"eva@example.com",
				"finn@example.com",
				"ida@example.com",
			],
		]);
	});

	// Review of #1650, round 4: taken back from an agent, a quoted address stood alone in the field and got the email.
	it("leaves who the email goes to as it stands when its writer changes, so what is no address stays so", async () => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		const wrong = () => texts(panel(), ".mailbox-chip.is-invalid .mailbox-chip-text");
		const said = () => panel().querySelector(".mailbox-write-error")?.textContent;
		const sends = () => calls(fake, "qorpera_send_member_mail");
		const enter = () =>
			to().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		const give = (name: string) => {
			panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
			menuRow(name).click();
		};
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		// Typed while an agent has it and not yet ended, it is still typed when the member takes the email back, whole:
		// the quoted address is not left alone in the field for the next reading.
		give("Ada");
		type(to(), '"old@example.com" new@example.com');
		expect(chips()).toEqual([]);
		give("You");
		expect(chips()).toEqual([]);
		expect(to().value).toBe('"old@example.com" new@example.com');
		// Send reads it as it was typed: the quoted text is a name, no address, and holds the email back.
		panel().requestSubmit();
		expect(said()).toBe('"old@example.com" is not an email address');
		expect(chips()).toEqual(['"old@example.com"', "new@example.com"]);
		expect(wrong()).toEqual(['"old@example.com"']);
		expect(to().value).toBe("");
		expect(sends()).toEqual([]);
		// A chip is never read again. An agent takes it as a name, so there it is not marked; back with the member it is
		// what it was, and still holds the email back.
		give("Ada");
		expect(chips()).toEqual(['"old@example.com"', "new@example.com"]);
		expect(wrong()).toEqual([]);
		give("You");
		expect(chips()).toEqual(['"old@example.com"', "new@example.com"]);
		expect(wrong()).toEqual(['"old@example.com"']);
		expect(to().value).toBe("");
		panel().requestSubmit();
		expect(said()).toBe('"old@example.com" is not an email address');
		expect(sends()).toEqual([]);
		// Nor are two chips put together: one after the other these would read as a quoted name and the address it
		// points at.
		type(to(), '"a');
		enter();
		type(to(), 'b " <older@example.com>');
		enter();
		give("Ada");
		give("You");
		expect(chips()).toEqual(['"old@example.com"', "new@example.com", '"a', 'b " <older@example.com>']);
		expect(wrong()).toEqual(['"old@example.com"', '"a', 'b " <older@example.com>']);
		expect(to().value).toBe("");
		panel().requestSubmit();
		expect(sends()).toEqual([]);
		// With those taken away it goes, to the one address.
		for (const name of ['"old@example.com"', '"a', 'b " <older@example.com>'])
			button(panel(), `Remove ${name}`)!.click();
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(sends().map((call) => (call.p_request as { to: string[] }).to)).toEqual([["new@example.com"]]);
	});

	it("takes a name as well as an address while an agent writes the email, and gives the agent both as its words", async () => {
		const { main, controller, fake } = await mailbox(() => {});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
		menuRow("Ada").click();
		// The comma ends the address and the name; no chip is marked, and the last name is still being typed.
		type(to(), "anna@example.com Nordlys Energi, Bo");
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@example.com", "Nordlys Energi"]);
		expect(panel().querySelector(".mailbox-chip.is-invalid")).toBeNull();
		expect(to().value).toBe("Bo");
		expect(to().placeholder).toBe("");
		type(panel().querySelector("textarea")!, "Ask when the new price starts.");
		panel().requestSubmit();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				"Please write an email to anna@example.com, Nordlys Energi, Bo from hello@acme.example: Ask when the new price starts.",
			),
		);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
		// The next email starts with nobody to go to.
		button(main, "Write")!.click();
		expect(texts(panel(), ".mailbox-chip-text")).toEqual([]);
		expect(to().value).toBe("");
	});

	// Review of #1650, round 5: pasted for an agent, "Anna (Acme); Anna (Beta)" lost what tells the two apart, and so
	// one of them.
	it("keeps an entry with no address whole, so two names are never made one", async () => {
		const { main, controller, fake } = await mailbox(() => {});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const chips = () => texts(panel(), ".mailbox-chip-text");
		const wrong = () => texts(panel(), ".mailbox-chip.is-invalid .mailbox-chip-text");
		const paste = (text: string) =>
			!to().dispatchEvent(
				Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
					clipboardData: { getData: () => text },
				}),
			);
		const give = (name: string) => {
			panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
			menuRow(name).click();
		};
		give("Ada");
		// A name is kept with its remark, and a quoted name with its comma: two entries, two chips.
		expect(paste("Anna (Acme); Anna (Beta)")).toBe(true);
		expect(chips()).toEqual(["Anna (Acme)", "Anna (Beta)"]);
		// So is an entry that points at what is no address, and one whose only `@` word is none: each as it stands.
		expect(paste('Anna <Acme>, Bo <Acme>\n"Holm, Carl"\t(Acme)\nDan @Acme; Eva @Acme')).toBe(true);
		const names = [
			"Anna (Acme)",
			"Anna (Beta)",
			"Anna <Acme>",
			"Bo <Acme>",
			'"Holm, Carl" (Acme)',
			"Dan @Acme",
			"Eva @Acme",
		];
		expect(chips()).toEqual(names);
		// Typed, the same.
		type(to(), "Finn (Acme), Finn (Beta),");
		expect(chips()).toEqual([...names, "Finn (Acme)", "Finn (Beta)"]);
		// An agent takes a name as well as an address, so for one a pasted list is read as if typed: the name that stands
		// beside an address with nothing pointing at it is a chip of its own, and so is one typed before what is pasted.
		expect(paste("Gry (Acme) gry@example.com; Gry (Beta) <gry@beta.example>")).toBe(true);
		type(to(), "Hans Holm ");
		to().setSelectionRange(10, 10);
		expect(paste("hans@example.com; ida@example.com")).toBe(true);
		const addresses = ["gry@example.com", "gry@beta.example", "hans@example.com", "ida@example.com"];
		const all = [
			...names,
			"Finn (Acme)",
			"Finn (Beta)",
			"Gry (Acme)",
			"gry@example.com",
			"gry@beta.example",
			"Hans Holm",
			"hans@example.com",
			"ida@example.com",
		];
		expect(chips()).toEqual(all);
		expect(to().value).toBe("");
		expect(wrong()).toEqual([]);
		// In the member's own email each name is a chip of its own too, and each says it is no address. Only an address
		// can be sent to there, so the name beside a pasted address is left out.
		give("You");
		expect(chips()).toEqual(all);
		expect(wrong()).toEqual(all.filter((each) => !addresses.includes(each)));
		expect(paste("Jon (Acme) jon@example.com")).toBe(true);
		expect(chips()).toEqual([...all, "jon@example.com"]);
		give("Ada");
		// The agent is told every one of them.
		type(panel().querySelector("textarea")!, "Ask when the new price starts.");
		panel().requestSubmit();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				`Please write an email to ${[...all, "jon@example.com"].join(", ")} from hello@acme.example: Ask when the new price starts.`,
			),
		);
		expect(calls(fake, "qorpera_send_member_mail")).toEqual([]);
	});

	it("holds the member's email back until it has who it goes to, a subject and its text, then sends it", async () => {
		const { main, fake } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const subject = () => panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!;
		const said = () => panel().querySelector(".mailbox-write-error")?.textContent;
		const sends = () => calls(fake, "qorpera_send_member_mail");
		// What holds it back is said in the window, with the keyboard in the field it is about.
		panel().requestSubmit();
		expect(said()).toBe("Add who the email goes to");
		expect(panel().querySelector(".mailbox-write-error")?.getAttribute("role")).toBe("alert");
		expect(document.activeElement).toBe(to());
		// Typing on takes what was said away. What is still typed goes with the chips, and one that is no address holds
		// the email back.
		type(to(), "jonas@gmaill");
		expect(said()).toBeUndefined();
		panel().requestSubmit();
		expect(said()).toBe("jonas@gmaill is not an email address");
		expect(panel().querySelector(".mailbox-chip.is-invalid .mailbox-chip-text")?.textContent).toBe("jonas@gmaill");
		expect(document.activeElement).toBe(to());
		button(panel(), "Remove jonas@gmaill")!.click();
		expect(said()).toBeUndefined();
		type(to(), "anna@outside.example");
		panel().requestSubmit();
		expect(said()).toBe("The email needs a subject");
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example"]);
		expect(document.activeElement).toBe(subject());
		type(subject(), "  The new   price ");
		panel().requestSubmit();
		expect(said()).toBe("The email needs its text");
		expect(document.activeElement).toBe(panel().querySelector("textarea"));
		expect(sends()).toEqual([]);
		// Whole, it goes: once, from the company's address, as the member wrote it.
		type(panel().querySelector("textarea")!, "When does it start?\n\n");
		panel().requestSubmit();
		expect(button(panel(), "Sending")?.disabled).toBe(true);
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(sends()).toEqual([
			{
				p_environment_id: profileA.environmentId,
				p_request: {
					sendId: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
					from: "hello@acme.example",
					to: ["anna@outside.example"],
					subject: "The new price",
					text: "When does it start?",
				},
			},
		]);
		// It says so with nobody's figure, and the keyboard is on Write again.
		const toast = main.querySelector<HTMLElement>(".mailbox-toast")!;
		expect(toast.textContent).toBe("Your email is on its way");
		expect(toast.querySelector(".figure")).toBeNull();
		expect(document.activeElement).toBe(button(main, "Write"));
		// Its thread is in the list as the member's own: their name, their picture, and nothing new to handle.
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		const line = lines(main)[0]!;
		expect(line.querySelector(".mailbox-who")?.textContent).toBe("anna@outside.example, You");
		expect(line.querySelector(".mailbox-subject")?.textContent).toBe("The new price");
		expect(line.querySelector(".mailbox-snippet")?.textContent).toBe(" — You: When does it start?");
		expect(line.querySelector(".mailbox-handler")?.getAttribute("title")).toBe("You sent it");
		expect(line.querySelector(".mailbox-handler .person-avatar")).not.toBeNull();
		expect(line.querySelector(".mailbox-state")).toBeNull();
		tab(main, "Sent");
		await vi.waitFor(() =>
			expect(lines(main)[0]?.querySelector(".mailbox-who")?.textContent).toBe("To:anna@outside.example"),
		);
		expect(lines(main)).toHaveLength(1);
		// The next email starts empty.
		button(main, "Write")!.click();
		expect(texts(panel(), ".mailbox-chip-text")).toEqual([]);
		expect(subject().value).toBe("");
		expect(panel().querySelector("textarea")!.value).toBe("");
	});

	it("says why the member's email could not go, and sends the same one again until it is changed", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.sendError = { message: "Sending company mail is switched off", code: "0A000" };
		});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const said = () => panel().querySelector(".mailbox-write-error")?.textContent;
		const ids = () =>
			calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { sendId: string }).sendId);
		type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "anna@outside.example");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		// The cloud's own sentence, in the window, which keeps the email; the keyboard is on Send.
		await vi.waitFor(() => expect(said()).toBe("Sending company mail is switched off"));
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example"]);
		expect(panel().querySelector("textarea")!.value).toBe("Hi.");
		expect(document.activeElement).toBe(button(panel(), "Send"));
		expect(main.querySelector(".mailbox-toast")).toBeNull();
		// Sent again as it stands, it is the same email, so the cloud sends it once however often it is asked.
		panel().requestSubmit();
		await vi.waitFor(() => expect(ids()).toHaveLength(2));
		await vi.waitFor(() => expect(said()).toBe("Sending company mail is switched off"));
		expect(ids()[1]).toBe(ids()[0]);
		// Changed, it is a new email.
		type(panel().querySelector("textarea")!, "Hi again.");
		expect(said()).toBeUndefined();
		fake.sendError = undefined;
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(ids()).toHaveLength(3);
		expect(ids()[2]).not.toBe(ids()[0]);
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your email is on its way");
	});

	it("lets nothing in the Write window be changed while the member's email is on its way, and brings the window back when it could not go", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.addresses = [ADDRESS, { ...ADDRESS, address: "sales@acme.example", handledBy: [], routines: [] }];
		});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const chip = () => panel().querySelector<HTMLButtonElement>(".mailbox-writer")!;
		const requests = () => calls(fake, "qorpera_send_member_mail").map((call) => call.p_request);
		type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "anna@outside.example ");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		const open = [
			"Close",
			"writer",
			"from",
			"Remove anna@outside.example",
			"To",
			"write-subject",
			"write-text",
			"write-send",
		];
		expect(usable(panel())).toEqual(open);
		// The cloud is slow to answer, and the Writer chip's menu is open over the window.
		let release: () => void = () => {};
		fake.sendHold = new Promise<void>((resolve) => {
			release = resolve;
		});
		chip().click();
		panel().requestSubmit();
		await vi.waitFor(() => expect(requests()).toHaveLength(1));
		// What is in the window is what is being sent: only the window itself can still be shut, and the menu left open
		// over it picks nothing.
		expect(usable(panel())).toEqual(["Close"]);
		expect(button(panel(), "Sending")).toBeDefined();
		menuRow("Ada").click();
		expect(chip().querySelector(".mailbox-writer-name")?.textContent).toBe("You");
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example"]);
		// Shut meanwhile, the window comes back with the email and why it did not go, the keyboard on Send.
		button(panel(), "Close")!.click();
		expect(main.querySelector(".mailbox-write-panel")).toBeNull();
		fake.sendError = { message: "Sending company mail is switched off", code: "0A000" };
		release();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-write-error")?.textContent).toBe("Sending company mail is switched off"),
		);
		expect(usable(panel())).toEqual(open);
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example"]);
		expect(panel().querySelector("textarea")!.value).toBe("Hi.");
		expect(document.activeElement).toBe(button(panel(), "Send"));
		// Sent again as it stands, it is the same email in every part.
		fake.sendError = undefined;
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(requests()).toHaveLength(2);
		expect(requests()[1]).toEqual(requests()[0]);
		expect(requests()[1]).toMatchObject({
			from: "hello@acme.example",
			to: ["anna@outside.example"],
			subject: "Hello",
			text: "Hi.",
		});
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your email is on its way");
	});

	it("lets nothing in the Write window be changed while its words are on their way to an agent, and keeps them when they could not go", async () => {
		const { main, controller } = await mailbox(() => {});
		vi.spyOn(controller, "openStaffConversation")
			.mockRejectedValueOnce(new Error("Ada's thread can't be opened here."))
			.mockResolvedValue(session.sessionId);
		let answer: (went: boolean) => void = () => {};
		const send = vi.spyOn(controller, "sendPrompt").mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		);
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
		menuRow("Ada").click();
		type(panel().querySelector("input")!, "Nordlys Energi");
		type(panel().querySelector("textarea")!, "Ask when the new price starts.");
		const open = ["Close", "writer", "To", "write-text", "write-send"];
		expect(usable(panel())).toEqual(open);
		// Ada's thread can't be opened: the page says so, and the window keeps its words, the keyboard on its button.
		panel().requestSubmit();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice-danger")?.textContent).toContain("Ada's thread can't be opened here."),
		);
		expect(send).not.toHaveBeenCalled();
		expect(usable(panel())).toEqual(open);
		expect(panel().querySelector("input")!.value).toBe("Nordlys Energi");
		expect(panel().querySelector("textarea")!.value).toBe("Ask when the new price starts.");
		expect(document.activeElement).toBe(button(panel(), "Ask Ada to write it"));
		// Asked again, the words are on their way: until Ada has them, only the window itself can be shut.
		panel().requestSubmit();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(usable(panel())).toEqual(["Close"]);
		answer(true);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada is writing it");
		expect(document.activeElement).toBe(button(main, "Write"));
	});

	it("keeps the id of the member's email only while it is the same email, whoever had it meanwhile", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.sendError = { message: "Sending company mail is switched off", code: "0A000" };
		});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const said = () => panel().querySelector(".mailbox-write-error")?.textContent;
		const requests = () =>
			calls(fake, "qorpera_send_member_mail").map((call) => call.p_request as { sendId: string; to: string[] });
		const ids = () => requests().map((request) => request.sendId);
		const give = (name: string) => {
			panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
			menuRow(name).click();
		};
		type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "anna@outside.example");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		await vi.waitFor(() => expect(said()).toBe("Sending company mail is switched off"));
		// Given to an agent and taken back as it was, it is the same email still.
		give("Ada");
		give("You");
		expect(said()).toBeUndefined();
		panel().requestSubmit();
		await vi.waitFor(() => expect(said()).toBe("Sending company mail is switched off"));
		expect(ids()).toHaveLength(2);
		expect(ids()[1]).toBe(ids()[0]);
		// Who it goes to was changed while the agent had it: back with the member it is a new email, to the new address,
		// and not the first one answered for again.
		give("Ada");
		button(panel(), "Remove anna@outside.example")!.click();
		type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "bo@outside.example,");
		give("You");
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["bo@outside.example"]);
		fake.sendError = undefined;
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(ids()).toHaveLength(3);
		expect(ids()[2]).not.toBe(ids()[0]);
		expect(requests()[2]?.to).toEqual(["bo@outside.example"]);
	});

	it.each([
		["failed", "This email could not be sent. Send it again to try once more."],
		["cancelled", "This email was cancelled before it went. Send it again if it should still go."],
	])(
		"keeps the member's email when an earlier try of it ended as %s, and sends the next as a new one",
		async (status, sentence) => {
			const { main, fake } = await mailbox((mail) => {
				mail.sendError = { message: "The cloud did not answer", code: "57014" };
			});
			await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
			button(main, "Write")!.click();
			const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
			const said = () => panel().querySelector(".mailbox-write-error")?.textContent;
			const ids = () =>
				calls(fake, "qorpera_send_member_mail").map((call) => (call.p_request as { sendId: string }).sendId);
			type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "anna@outside.example");
			type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
			type(panel().querySelector("textarea")!, "Hi.");
			panel().requestSubmit();
			await vi.waitFor(() => expect(said()).toBe("The cloud did not answer"));
			// That try did reach the cloud: the email was queued there, and then did not go. Asked for again, the cloud
			// answers with how it ended and queues nothing, so the window says so and keeps the email.
			fake.sendError = undefined;
			fake.sendStatus = status;
			panel().requestSubmit();
			await vi.waitFor(() => expect(said()).toBe(sentence));
			expect(ids()).toHaveLength(2);
			expect(ids()[1]).toBe(ids()[0]);
			expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example"]);
			expect(panel().querySelector("textarea")!.value).toBe("Hi.");
			expect(main.querySelector(".mailbox-toast")).toBeNull();
			expect(document.activeElement).toBe(button(panel(), "Send"));
			// The next Send is a new email, which goes.
			fake.sendStatus = undefined;
			panel().requestSubmit();
			await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
			expect(ids()).toHaveLength(3);
			expect(ids()[2]).not.toBe(ids()[0]);
			expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your email is on its way");
		},
	);

	it("takes the member's email as gone when an earlier try of it was sent", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.sendError = { message: "The cloud did not answer", code: "57014" };
		});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		type(panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!, "anna@outside.example");
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		await vi.waitFor(() =>
			expect(panel().querySelector(".mailbox-write-error")?.textContent).toBe("The cloud did not answer"),
		);
		fake.sendError = undefined;
		fake.sendStatus = "sent";
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail")).toHaveLength(2);
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Your email is on its way");
	});

	it("lets the member pick which address in use their email goes from, when the company has several", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.addresses = [
				ADDRESS,
				{ ...ADDRESS, address: "sales@acme.example", handledBy: [], routines: [] },
				{ ...ADDRESS, address: "old@acme.example", status: "paused", handledBy: [], routines: [] },
			];
		});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const from = () => panel().querySelector<HTMLButtonElement>(".mailbox-sender")!;
		expect(texts(panel(), ".mailbox-write-label")).toEqual(["Writer", "From", "To", "Subject"]);
		expect(from().querySelector(".mailbox-sender-name")?.textContent).toBe("hello@acme.example");
		// The chip says where it goes from, so the foot does not say it again.
		expect(panel().querySelector(".mailbox-from-address")).toBeNull();
		// A paused address sends nothing, so it is not offered.
		from().click();
		expect(from().getAttribute("aria-expanded")).toBe("true");
		expect(texts(openMenu()!.el, ".context-menu-label")).toEqual(["hello@acme.example", "sales@acme.example"]);
		expect(texts(openMenu()!.el, "[aria-checked='true'] .context-menu-label")).toEqual(["hello@acme.example"]);
		menuRow("sales@acme.example").click();
		expect(openMenu()).toBeUndefined();
		expect(from().querySelector(".mailbox-sender-name")?.textContent).toBe("sales@acme.example");
		expect(document.activeElement).toBe(from());
		type(
			panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!,
			"anna@outside.example, bo@outside.example",
		);
		type(panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!, "Hello");
		type(panel().querySelector("textarea")!, "Hi.");
		panel().requestSubmit();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(calls(fake, "qorpera_send_member_mail")).toMatchObject([
			{ p_request: { from: "sales@acme.example", to: ["anna@outside.example", "bo@outside.example"] } },
		]);
		// An agent's email goes from the address its writer answers: there is nothing to pick.
		button(main, "Write")!.click();
		panel().querySelector<HTMLButtonElement>(".mailbox-writer")!.click();
		menuRow("Ada").click();
		expect(panel().querySelector(".mailbox-sender")).toBeNull();
		expect(panel().querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
	});

	it("keeps who the email goes to when its writer changes: the same chips, and what is typed after them", async () => {
		const { main } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const chip = () => panel().querySelector<HTMLButtonElement>(".mailbox-writer")!;
		const to = () => panel().querySelector<HTMLInputElement>(".mailbox-write-to input")!;
		const subject = () => panel().querySelector<HTMLInputElement>("[data-focus-key='write-subject']")!;
		type(to(), "anna@outside.example, bo@outside.example Carl");
		type(subject(), "The new price");
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example", "bo@outside.example"]);
		// With an agent the row is the same one: its chips, each with its own button, and the name still typed.
		chip().click();
		menuRow("Ada").click();
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example", "bo@outside.example"]);
		expect(to().value).toBe("Carl");
		expect(to()).toBe(panel().querySelector("input"));
		expect(button(panel(), "Remove bo@outside.example")).toBeDefined();
		// Back with the member it is as it was, and so is the subject.
		chip().click();
		menuRow("You").click();
		expect(texts(panel(), ".mailbox-chip-text")).toEqual(["anna@outside.example", "bo@outside.example"]);
		expect(to().value).toBe("Carl");
		expect(subject().value).toBe("The new price");
		expect(button(panel(), "Send")).toBeDefined();
	});

	it("opens the Writer chip's menu on a click and shuts it on the next, and keeps a started email's writer", async () => {
		const { main } = await mailbox(() => {});
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const chip = () => main.querySelector<HTMLButtonElement>(".mailbox-writer")!;
		const writer = () => chip().querySelector(".mailbox-writer-name")?.textContent;
		const to = () => main.querySelector<HTMLInputElement>(".mailbox-write-panel input")!;
		const close = () => main.querySelector<HTMLButtonElement>(".mailbox-write-head .mailbox-icon")!.click();
		chip().click();
		expect(openMenu()).toBeDefined();
		expect(chip().getAttribute("aria-expanded")).toBe("true");
		// A press on the chip shuts its menu, and the click that press ends in does not open it again.
		const press = (target: HTMLElement) => target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		const pointerClick = () => {
			press(chip());
			chip().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		};
		pointerClick();
		expect(openMenu()).toBeUndefined();
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		// The click after that opens it again.
		pointerClick();
		expect(openMenu()).toBeDefined();
		// A press anywhere else shuts it.
		press(to());
		expect(openMenu()).toBeUndefined();
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		// Given to the Co-Founder, who answers no address: it goes from the company's first, and the keyboard is on the
		// chip again.
		chip().click();
		menuRow("Co-Founder").click();
		expect(writer()).toBe("Co-Founder");
		expect(document.activeElement).toBe(chip());
		expect(main.querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		// Shut and opened again: an email that was started keeps its writer, an empty one is nobody's.
		type(to(), "Nordlys Energi");
		close();
		button(main, "Write")!.click();
		expect(writer()).toBe("Co-Founder");
		type(to(), "");
		close();
		button(main, "Write")!.click();
		expect(writer()).toBe("You");
	});

	// On a short page the Write window scrolls, and so does its text. Measured in Chromium with the Mailbox 912×300
	// and 500×240: the page's next read of the mail once sent the list, the window and its text back to their tops
	// (the window's foot, with its button, out of view again) and the caret to the start of the text.
	it("leaves the list, the Write window, its text and the caret where they were when the mail is read again", async () => {
		vi.useFakeTimers();
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1), summary(2)];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(2));
		button(main, "Write")!.click();
		const list = () => main.querySelector<HTMLElement>(".mailbox-scroll")!;
		const panel = () => main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		const first = panel();
		const text = first.querySelector("textarea")!;
		text.focus();
		type(text, "Ask when the new price starts.\n".repeat(30));
		text.setSelectionRange(400, 410);
		scrolledTo(list(), 60);
		scrolledTo(first, 78);
		scrolledTo(text, 220);
		// New mail came, and the page's next read draws it.
		fake.threads = [summary(3), summary(1), summary(2)];
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(3));
		expect(panel()).not.toBe(first);
		expect(list().scrollTop).toBe(60);
		expect(panel().scrollTop).toBe(78);
		const again = panel().querySelector("textarea")!;
		expect(again.scrollTop).toBe(220);
		expect(document.activeElement).toBe(again);
		expect([again.selectionStart, again.selectionEnd]).toEqual([400, 410]);
		// The Writer chip's menu stays open over the page's next read, which draws the chip again, as open. The agent
		// then picked leaves the keyboard on the chip, and the window where it was.
		const chip = () => panel().querySelector<HTMLButtonElement>(".mailbox-writer")!;
		const opened = chip();
		opened.focus();
		opened.click();
		fake.threads = [summary(4), summary(3), summary(1), summary(2)];
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(4));
		expect(chip()).not.toBe(opened);
		expect(chip().getAttribute("aria-expanded")).toBe("true");
		// A press on the chip drawn anew shuts the menu the old one opened, and its click opens nothing.
		chip().dispatchEvent(new Event("pointerdown", { bubbles: true }));
		chip().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		expect(openMenu()).toBeUndefined();
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		chip().click();
		menuRow("Co-Founder").click();
		expect(openMenu()).toBeUndefined();
		expect(chip().querySelector(".mailbox-writer-name")?.textContent).toBe("Co-Founder");
		expect(chip().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(chip());
		expect(panel().scrollTop).toBe(78);
		expect(panel().querySelector("textarea")!.scrollTop).toBe(220);
	});

	// jsdom has no layout, so this reads the rules that hold the Write window together on a short page (a phone with
	// its keyboard up). Measured in Chromium with the Mailbox 500×300 and 912×300: the text once kept its full height
	// and ran over the foot, and the window's clip hid the rest.
	it("lets the Write window's text give way, and the window scroll, on a short page", () => {
		const css = readFileSync(resolve("src/styles/mailbox.css"), "utf8");
		const rule = (selector: string) =>
			css.match(new RegExp(`^${selector.replaceAll(".", "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
		expect(rule(".mailbox-write-panel")).toContain("max-height: calc(100% - 16px); overflow: hidden auto;");
		// Only the text gives way: down to a floor, and then the window scrolls.
		expect(rule(".mailbox-write-text")).toMatch(
			/flex: 0 1 auto; display: flex; flex-direction: column; min-height: \d+px;/,
		);
		expect(rule(".mailbox-write-text textarea")).toContain("flex: 1; min-width: 0; min-height: 0;");
		for (const fixed of [".mailbox-write-head", ".mailbox-write-row", ".mailbox-write-error", ".mailbox-write-foot"])
			expect(rule(fixed)).toContain("flex: none;");
	});

	it("draws no Send, answer, Write or Change for a viewer", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting" })];
			mail.waiting = [waitingItem(id(901))];
		}, "viewer");
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(main.querySelector(".mailbox-actions button")).toBeNull();
		expect(button(main, "Write")).toBeUndefined();
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-message")).not.toBeNull());
		expect(main.querySelector(".mailbox-answers")).toBeNull();
		expect(button(main, "Reply")).toBeUndefined();
		button(main, "Back to Inbox")!.click();
		// Addresses shows each address and who answers it, with nothing to change.
		tab(main, "Addresses");
		await vi.waitFor(() => expect(main.querySelector(".hook-card")).not.toBeNull());
		expect(main.querySelector(".mailbox-answer-line .mailbox-address-agent")?.textContent).toBe("Ada answers it");
		expect(main.querySelector(".mailbox-answerer")).toBeNull();
		expect(main.querySelector(".mailbox-manage .connection-actions button")).toBeNull();
		expect(button(main, "Add mailbox")).toBeUndefined();
		expect(main.querySelector(".mailbox-manage .digital-post")).toBeNull();
	});
});

describe("what a member sees before answering, and who did what", () => {
	it("shows every recipient and the subject a send goes with, on its line and in its thread", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting" })];
			mail.waiting = [waitingItem(id(901), { cc: ["boss@outside.example"], subject: "Re: Subject 1 (changed)" })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [received(1)],
				more: false,
				waiting: [waitingSend(id(901), { cc: ["boss@outside.example"], subject: "Re: Subject 1 (changed)" })],
			};
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(lines(main)[0]!.querySelector(".mailbox-recipients")?.textContent).toBe(
			"to sender1@outside.example · cc boss@outside.example",
		);
		expect(lines(main)[0]!.querySelector(".mailbox-subject")?.textContent).toBe("Re: Subject 1 (changed)");
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-draft")).not.toBeNull());
		expect(texts(main.querySelector(".mailbox-draft")!, ".mailbox-draft-field")).toEqual([
			"cc boss@outside.example",
			"Re: Subject 1 (changed)",
		]);
	});

	it("shows where a reply goes when it goes to someone other than the thread's sender", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting" })];
			mail.waiting = [waitingItem(id(904), { to: ["someone.else@outside.example"] })];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		const line = lines(main)[0]!;
		expect(line.querySelector(".mailbox-who")?.textContent).toBe("Sender 1");
		expect(line.querySelector(".mailbox-recipients")?.textContent).toBe("to someone.else@outside.example");
		expect(texts(line, ".mailbox-actions button")).toEqual(["Don't send", "Send"]);
	});

	it("answers a send that starts a new email, which has no thread, and links its line to the agent's thread", async () => {
		const { main, f, fake } = await mailbox((mail) => {
			mail.waiting = [waitingItem(id(903), { thread: null, to: ["new@outside.example"], subject: "Hello" })];
		});
		const answer = vi.spyOn(f.api, "answerActionReview").mockImplementation(async (reviewId, _input, given) => {
			fake.waiting = [];
			return { reviewId, answer: given, inputId: id(950), savedRuleId: null, woke: true };
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		const line = lines(main)[0]!;
		expect(line.querySelector("a.mailbox-open")?.getAttribute("data-href")).toBe(
			`#/c/${profileA.profileId}/staff/${ada.id}`,
		);
		expect(line.querySelector(".mailbox-who")?.textContent).toBe("new@outside.example");
		button(line, "Send")!.click();
		await vi.waitFor(() =>
			expect(answer).toHaveBeenCalledWith(id(903), expect.any(String), "allow_once", undefined, expect.anything()),
		);
		expect(calls(fake, "qorpera_member_mail_thread")).toEqual([]);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(0));
	});

	it("says a cancelled email was cancelled, never sent", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { direction: "sent", state: "handled" })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					{
						kind: "sent",
						mailId: id(701),
						fromAddress: ADDRESS.address,
						to: ["sender1@outside.example"],
						cc: [],
						subject: "Re: Subject 1",
						text: "We are closed on Monday.",
						textCleared: false,
						status: "cancelled",
						at: at(1),
						staffAgent: { staffAgentId: ada.id, name: "Ada" },
						attachments: [],
					},
				],
				more: false,
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-status")).not.toBeNull());
		expect(main.querySelector(".mailbox-status")?.textContent).toBe("Cancelled");
		expect(main.querySelector(".mailbox-status")?.classList.contains("is-failed")).toBe(true);
	});

	it("shows an email a member sent themself as theirs, with their picture, on its line and in its thread", async () => {
		const mine = { userId: userA.id, name: "Account A" };
		const { main } = await mailbox((mail) => {
			// A thread a member started has no agent, and the address it went to as its outside party.
			mail.threads = [
				summary(1, {
					fromName: undefined,
					fromAddress: "anna@outside.example",
					state: "handled",
					handledBy: undefined,
					direction: "sent",
					snippet: "See you Friday.",
					sentBy: mine,
				}),
				summary(2, {
					state: "handled",
					handledBy: undefined,
					direction: "sent",
					snippet: "Thanks.",
					sentBy: { userId: id(2), name: "Bea Berg" },
				}),
			];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					{
						kind: "sent",
						mailId: id(702),
						fromName: "Account A at Acme",
						fromAddress: ADDRESS.address,
						to: ["anna@outside.example"],
						cc: [],
						subject: "Subject 1",
						text: "See you Friday.",
						textCleared: false,
						status: "sent",
						at: at(1),
						member: mine,
						attachments: [],
					},
				],
				more: false,
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(2));
		const [own, other] = lines(main) as [HTMLElement, HTMLElement];
		// The member's own is "You"; another member's has their name.
		expect(own.querySelector(".mailbox-who")?.textContent).toBe("anna@outside.example, You");
		expect(own.querySelector(".mailbox-snippet")?.textContent).toBe(" — You: See you Friday.");
		expect(own.querySelector(".mailbox-handler")?.getAttribute("title")).toBe("You sent it");
		expect(own.querySelector(".mailbox-handler .person-avatar")).not.toBeNull();
		expect(own.querySelector(".figure")).toBeNull();
		expect(own.querySelector(".mailbox-state")).toBeNull();
		expect(other.querySelector(".mailbox-who")?.textContent).toBe("Sender 2, Bea Berg");
		expect(other.querySelector(".mailbox-snippet")?.textContent).toBe(" — Bea Berg: Thanks.");
		expect(other.querySelector(".mailbox-handler")?.getAttribute("title")).toBe("Bea Berg sent it");
		expect(other.querySelector(".mailbox-handler .person-avatar")).not.toBeNull();
		own.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-message")).not.toBeNull());
		const message = main.querySelector<HTMLElement>(".mailbox-message")!;
		expect(message.firstElementChild?.classList.contains("person-avatar")).toBe(true);
		expect(message.querySelector(".figure")).toBeNull();
		expect(message.querySelector(".mailbox-from strong")?.textContent).toBe("You");
		expect(message.querySelector(".mailbox-to")?.textContent).toBe("to anna@outside.example");
		expect(message.querySelector(".mailbox-status")?.textContent).toBe("Sent");
		expect(message.querySelector(".mailbox-text-body")?.textContent).toBe("See you Friday.");
	});

	it("names the agent who used an account, not the one who handles its mail", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [
				summary(1, { subject: undefined, account: { site: "wolt.example", lastUsedBy: bo.id }, state: "handled" }),
				summary(2, { subject: undefined, account: { unknown: true }, state: "handled" }),
			];
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(2));
		expect(texts(main, ".mailbox-row .mailbox-snippet")).toEqual([
			" — Bo used the account",
			" — Not known who used the account",
		]);
	});

	it("leaves the note in the agent's thread when its draft changes while the account is chosen", async () => {
		const { main, controller, accounts } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: "Invoice 42", fromName: "Jane", state: "handled" })];
		});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		// Another tab adds words to the same conversation while the account is being chosen.
		accounts.selectSessionAccount.mockImplementation(async () => {
			const store = controller.conversation(session.sessionId);
			store.set({ draft: `${store.get().draft ?? ""} and also delete the file` });
			return id(880);
		});
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		await answerAs(main, "Ada", "Say we pay on Friday.");
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`));
		expect(send).not.toHaveBeenCalled();
		expect(controller.conversation(session.sessionId).get().draft).toContain("and also delete the file");
	});
});

/** The company folder with Digital Post's letters (by `n`): the index lists them and each has its letter.md. */
function postFolder(letters: readonly number[], more: Record<number, Record<string, unknown>> = {}): FolderFake {
	const folder = folderFake();
	for (const n of letters) folder.put(`${letterFolder(n)}/letter.md`, letterMarkdown(n));
	folder.put("digital-post/letters.json", letterIndex(letters.map((n) => letter(n, more[n]))));
	return folder;
}

describe("Digital Post", () => {
	it("lists the letters among the threads by when they came, with the authority as their sender", async () => {
		const folder = postFolder([3, 7], { 3: { legalNotification: true } });
		const { main } = await mailbox(
			(mail) => {
				mail.threads = [summary(1, { state: "handled" }), summary(5, { state: "handled" })];
				mail.digitalPost = digitalPostConnected({ letters: 2 });
			},
			"owner",
			folder,
		);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(4));
		expect(lines(main).map((line) => line.querySelector(".mailbox-who")?.textContent)).toEqual([
			"Sender 1",
			"Skattestyrelsen",
			"Sender 5",
			"Skattestyrelsen",
		]);
		const [, legal, , plain] = lines(main);
		expect(legal!.classList.contains("is-letter")).toBe(true);
		expect(texts(legal!, ".mailbox-line > span")).toEqual(["Legal effect", "Letter 3", " — The start of letter 3."]);
		expect(legal!.querySelector(".mailbox-subject")?.getAttribute("title")).toBe("From outside the company");
		expect(legal!.querySelector(".mailbox-post")?.getAttribute("title")).toBe("Digital Post");
		expect(plain!.querySelector(".mailbox-state")).toBeNull();
		// The search finds letters by their sender, title and text too.
		type(main.querySelector<HTMLInputElement>(".mailbox-search input")!, "letter 7");
		expect(lines(main).map((line) => line.querySelector(".mailbox-subject")?.textContent)).toEqual(["Letter 7"]);
		// Sent lists only what the company wrote.
		type(main.querySelector<HTMLInputElement>(".mailbox-search input")!, "");
		tab(main, "Sent");
		expect(main.querySelector(".is-letter")).toBeNull();
	});

	it("opens a letter to its text and documents, and a note about it goes to the Co-Founder by its id", async () => {
		const folder = postFolder([3], { 3: { legalNotification: true, mandatory: true, caseId: "SKAT-2026-1" } });
		const { main, controller } = await mailbox(
			(mail) => {
				mail.digitalPost = digitalPostConnected();
			},
			"owner",
			folder,
		);
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ sessionId: session.sessionId });
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-letter-text")?.textContent).toBe("Dear company,\n\nPay by 1 November."),
		);
		expect(main.querySelector(".mailbox-letter-text")?.getAttribute("title")).toBe("From outside the company");
		expect(main.querySelector(".mailbox-thread-head h1")?.textContent).toBe("Letter 3");
		expect(main.querySelector(".mailbox-flags")?.textContent).toBe(
			"Legal effect · Mandatory post · Case SKAT-2026-1",
		);
		// The documents and the letter's folder open in Storage.
		expect(texts(main, ".mailbox-documents li")).toEqual(["Afgørelse.pdf", "Bilag 1.pdf"]);
		expect(
			[...main.querySelectorAll<HTMLElement>("[data-folder-path]")].map((each) => each.dataset.folderPath),
		).toEqual([`${letterFolder(3)}/Afgørelse.pdf`, `${letterFolder(3)}/Bilag 1.pdf`, letterFolder(3)]);
		expect(main.querySelector<HTMLSelectElement>(".mailbox-agent-pick")?.value).toBe(cofounder.id);
		const note = main.querySelector<HTMLInputElement>(".mailbox-composer input")!;
		expect(note.placeholder).toBe("Tell Co-Founder what to do with this letter");
		type(note, "Pay it on Friday.");
		main.querySelector<HTMLFormElement>(".mailbox-composer")!.requestSubmit();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		// The letter is named by its id and its year's folder: an authority's words are never the member's.
		expect(send).toHaveBeenCalledWith(
			session.sessionId,
			`About the Digital Post letter ${letterId(3)} (its folder in digital-post/2026 ends with its id): Pay it on Friday.`,
		);
		expect(controller.draftQuotes(session.sessionId)).toEqual([]);
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Co-Founder has your note"),
		);
		// Another agent can take the next note.
		const pick = main.querySelector<HTMLSelectElement>(".mailbox-agent-pick")!;
		pick.value = ada.id;
		pick.dispatchEvent(new Event("change", { bubbles: true }));
		expect(main.querySelector<HTMLInputElement>(".mailbox-composer input")?.placeholder).toBe(
			"Tell Ada what to do with this letter",
		);
		button(main, "Back to Inbox")!.click();
		expect(lines(main)).toHaveLength(1);
		expect(main.querySelector(".mailbox-composer")).toBeNull();
	});

	it("shows the Mailbox for Digital Post alone, without Write, and its row in Addresses asks for a reader", async () => {
		const { main, controller } = await mailbox(
			(mail) => {
				mail.addresses = [];
				mail.digitalPost = digitalPostConnected({ letters: 0 });
			},
			"owner",
			folderFake(),
		);
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ sessionId: session.sessionId });
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-empty h1")?.textContent).toBe("No Digital Post yet"));
		expect(main.querySelector(".mailbox-tabs")).not.toBeNull();
		expect(button(main, "Write")).toBeUndefined();
		tab(main, "Addresses");
		const row = () => main.querySelector<HTMLElement>(".mailbox-address.is-digital-post")!;
		expect(row().querySelector(".mailbox-address-name strong")?.textContent).toBe("Digital Post");
		expect(row().querySelector(".mailbox-address-agent")?.textContent).toMatch(/^Checked /);
		expect(row().querySelector(".mailbox-week")?.textContent).toBe("0");
		button(row(), "Choose who reads it")!.click();
		button(row(), "Bo")!.click();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				"Please have Bo read the company's Digital Post: a routine that wakes on new letters in digital-post/ (a file change, the whole folder), reads each letter's letter.md and acts on it.",
			),
		);
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-toast")?.textContent).toBe(
				"Asked Co-Founder to have Bo read Digital Post",
			),
		);
	});

	it("says Digital Post can be connected while the mail is off, and reads no folder for it", async () => {
		const folder = folderFake();
		const { main } = await mailbox(
			(mail) => {
				mail.addresses = [];
				mail.digitalPost = digitalPostConnected({
					connected: false,
					status: "disconnected",
					secretId: null,
					systemId: null,
					fetchedAt: null,
					letters: 0,
				});
			},
			"owner",
			folder,
		);
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-empty h1")?.textContent).toBe("The company has no email address yet"),
		);
		expect(texts(main, ".mailbox-empty p")).toContain(
			"Letters from public authorities come here too, once Digital Post is connected.",
		);
		expect(folder.folder.read).not.toHaveBeenCalled();
	});

	it("reads the index again only when it changed, and says when an open letter left the folder", async () => {
		vi.useFakeTimers();
		const folder = postFolder([3]);
		const { main } = await mailbox(
			(mail) => {
				mail.digitalPost = digitalPostConnected();
			},
			"owner",
			folder,
		);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(folder.folder.readFile).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(folder.folder.read.mock.calls.filter(([path]) => path === "digital-post/letters.json").length).toBe(2);
		expect(folder.folder.readFile).toHaveBeenCalledTimes(1);
		// A letter written into the folder shows on the page's next read.
		folder.put(`${letterFolder(1)}/letter.md`, letterMarkdown(1));
		folder.put("digital-post/letters.json", letterIndex([letter(1), letter(3)]));
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(2));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-letter-text")).not.toBeNull());
		folder.remove(letterFolder(1));
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-none")?.textContent).toBe(
				"This letter is no longer in the company folder.",
			),
		);
	});

	it("says a letter too long to show here opens from its folder", async () => {
		const folder = postFolder([3]);
		folder.put(`${letterFolder(3)}/letter.md`, letterMarkdown(3, "x".repeat(1024 * 1024)));
		const { main } = await mailbox(
			(mail) => {
				mail.digitalPost = digitalPostConnected();
			},
			"owner",
			folder,
		);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-none")?.textContent).toBe(
				"This letter is too long to show here. Open its folder to read it and its documents.",
			),
		);
		expect(main.querySelector<HTMLElement>(".mailbox-folder [data-folder-path]")?.dataset.folderPath).toBe(
			letterFolder(3),
		);
		// Only the index was downloaded.
		expect(folder.folder.readFile).toHaveBeenCalledTimes(1);
	});

	it("draws no note or Choose for a viewer", async () => {
		const { main } = await mailbox(
			(mail) => {
				mail.digitalPost = digitalPostConnected();
			},
			"viewer",
			postFolder([3]),
		);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		await vi.waitFor(() => expect(main.querySelector(".mailbox-letter-text")).not.toBeNull());
		expect(main.querySelector(".mailbox-composer")).toBeNull();
		button(main, "Back to Inbox")!.click();
		tab(main, "Addresses");
		expect(main.querySelector(".mailbox-address.is-digital-post")).not.toBeNull();
		expect(button(main, "Choose who reads it")).toBeUndefined();
	});
});
