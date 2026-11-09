// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import { type MailboxManage, renderMailbox } from "../src/app/views/mailbox.ts";
import type { EventHook } from "../src/cloud/event-hooks.ts";
import type { HostedProfileRole } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";
import {
	ADDRESS,
	accountsFake,
	ada,
	at,
	bo,
	cofounder,
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
 * with its older messages folded; a note to the handling agent goes as the member's own message, with the email's
 * outside words as quotes; Sent, Addresses, Write and search; what a viewer may not do is not drawn. */

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
	// The address and Digital Post calls behind Addresses: no hooks yet, Digital Post not connected.
	const hooks: EventHook[] = [];
	const manage: MailboxManage = {
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
	return { f, controller, fake, main, manage, accounts };
}

const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const calls = (fake: MailFake, fn: string) => fake.calls.filter((call) => call.fn === fn).map((call) => call.args);
const button = (root: ParentNode, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
	);
const lines = (main: HTMLElement) => [...main.querySelectorAll<HTMLElement>(".mailbox-row")];
const tab = (main: HTMLElement, name: string) => button(main.querySelector(".mailbox-tabs")!, name)?.click();
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}

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
		type(search, "cake");
		expect(texts(main, ".mailbox-row .mailbox-subject")).toEqual(["Subject 1"]);
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
		type(form.querySelector('input[aria-label="Mailbox name"]')!, "hello");
		type(form.querySelector('input[aria-label="What it is for"]')!, "Customer questions");
		none.fake.addresses = [ADDRESS];
		form.requestSubmit();
		await vi.waitFor(() =>
			expect(none.manage.hooks.createMailbox).toHaveBeenCalledWith("hello", "Customer questions", expect.anything()),
		);
		await vi.waitFor(() => expect(none.main.querySelector(".mailbox-tabs")).not.toBeNull());
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

	it("tells the handling agent what to answer, quoting the email's subject and sender", async () => {
		const { main, controller } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: "Invoice 42", fromName: "Jane", state: "handled" })];
		});
		const open = vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		const note = main.querySelector<HTMLInputElement>(".mailbox-composer input")!;
		expect(note.placeholder).toBe("Tell Ada what to answer");
		type(note, "Say we pay on Friday.");
		main.querySelector<HTMLFormElement>(".mailbox-composer")!.requestSubmit();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: ada.id }));
		const draft = "About the email «Invoice 42» from «Jane»: Say we pay on Friday.";
		expect(send).toHaveBeenCalledWith(session.sessionId, draft);
		const quote = (words: string) => ({
			start: draft.indexOf(words),
			end: draft.indexOf(words) + words.length,
			source: "mail",
			ref: thread(1),
		});
		expect(controller.draftQuotes(session.sessionId)).toEqual([quote("Invoice 42"), quote("Jane")]);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada has your note"));
		expect(main.querySelector<HTMLInputElement>(".mailbox-composer input")?.value).toBe("");
	});

	it("leaves a note that can't go from here waiting in the agent's thread", async () => {
		const { main, controller } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "handled" })];
		});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(false);
		// Something is drafted there already: the note is added after it, and nothing is sent from here.
		controller.conversation(session.sessionId).set({ draft: "Earlier words" });
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		type(main.querySelector<HTMLInputElement>(".mailbox-composer input")!, "Answer kindly.");
		main.querySelector<HTMLFormElement>(".mailbox-composer")!.requestSubmit();
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`));
		expect(send).not.toHaveBeenCalled();
		expect(controller.conversation(session.sessionId).get().draft).toContain("Answer kindly.");
	});

	it("shows an account thread's mail only as who used the account, with nothing to tell", async () => {
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
		expect(main.querySelector(".mailbox-composer")).toBeNull();
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

	it("lists each address with who answers it, and asks the Co-Founder to give it to another agent", async () => {
		const { main, controller } = await mailbox(() => {});
		vi.spyOn(controller, "openCofounderConversation").mockResolvedValue({ sessionId: session.sessionId });
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
		tab(main, "Addresses");
		expect(texts(main, ".mailbox-address-name strong")).toEqual(["hello@acme.example"]);
		expect(main.querySelector(".mailbox-address-agent")?.textContent).toBe("Ada answers it");
		expect(main.querySelector(".mailbox-week")?.textContent).toBe("12");
		button(main, "Change")!.click();
		expect(texts(main, ".mailbox-pick")).toEqual(["Co-Founder", "Ada", "Bo"]);
		expect(main.querySelector(".mailbox-pick.is-current")?.textContent).toBe("Ada");
		button(main, "Bo")!.click();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				"Please have Bo answer the email that comes to hello@acme.example.",
			),
		);
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-toast")?.textContent).toBe(
				"Asked Co-Founder to give hello@acme.example to Bo",
			),
		);
		// The company's addresses are made, paused and removed here, and Digital Post connected.
		await vi.waitFor(() => expect(button(main, "Add mailbox")).toBeDefined());
		expect(main.querySelector(".mailbox-addresses .mailbox-manage [data-hooks='mailbox']")).not.toBeNull();
		expect(main.querySelector(".mailbox-addresses .mailbox-manage [data-hooks='webhook']")).toBeNull();
		expect(main.querySelector(".mailbox-addresses .mailbox-manage .digital-post")).not.toBeNull();
	});

	it("builds the address cards again for a company opened again, and in a new language", async () => {
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
		// A new language builds them again in it.
		setLanguagePreference("da");
		cleanup.push(() => setLanguagePreference("system"));
		renderMailbox(main, again, "mailbox", { manage: () => manage });
		await vi.waitFor(() => expect(button(main, "Tilføj postkasse")).toBeDefined());
	});

	it("asks the chosen agent to write an email, from the address it answers", async () => {
		const { main, controller } = await mailbox(() => {});
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const send = vi.spyOn(controller, "sendPrompt").mockResolvedValue(true);
		await vi.waitFor(() => expect(button(main, "Write")).toBeDefined());
		button(main, "Write")!.click();
		const panel = main.querySelector<HTMLFormElement>(".mailbox-write-panel")!;
		expect(texts(panel, ".mailbox-pick")).toEqual(["Ada", "Co-Founder"]);
		expect(panel.querySelector(".mailbox-from-address")?.textContent).toBe("from hello@acme.example");
		type(panel.querySelector("input")!, "Nordlys Energi");
		type(panel.querySelector("textarea")!, "Ask when the new price starts.");
		panel.requestSubmit();
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				session.sessionId,
				"Please write an email to Nordlys Energi from hello@acme.example: Ask when the new price starts.",
			),
		);
		await vi.waitFor(() => expect(main.querySelector(".mailbox-write-panel")).toBeNull());
		expect(main.querySelector(".mailbox-toast")?.textContent).toBe("Ada is writing it");
	});

	it("draws no Send, note, Write or Change for a viewer", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { state: "waiting" })];
			mail.waiting = [waitingItem(id(901))];
		}, "viewer");
		await vi.waitFor(() => expect(lines(main)).toHaveLength(1));
		expect(main.querySelector(".mailbox-actions button")).toBeNull();
		expect(button(main, "Write")).toBeUndefined();
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		expect(main.querySelector(".mailbox-composer")).toBeNull();
		button(main, "Back to Inbox")!.click();
		tab(main, "Addresses");
		expect(button(main, "Change")).toBeUndefined();
		expect(main.querySelector(".mailbox-manage")).toBeNull();
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
		expect(line.querySelector("a.mailbox-open")?.getAttribute("href")).toBe(
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
		lines(main)[0]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
		type(main.querySelector<HTMLInputElement>(".mailbox-composer input")!, "Say we pay on Friday.");
		main.querySelector<HTMLFormElement>(".mailbox-composer")!.requestSubmit();
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
