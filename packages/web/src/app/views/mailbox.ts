import type { DigitalPostLetter } from "../../cloud/digital-post.ts";
import type {
	MailAccount,
	MailAddress,
	MailMessage,
	MailThreadSummary,
	MailWaitingItem,
	MailWaitingSend,
} from "../../cloud/mail.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { fmtTime, h, icon, notice, spinner } from "../../ui/dom.ts";
import { presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	CompanyMail,
	digitalPostOf,
	type MailList,
	type MailListRequest,
	mailListKey,
	mailShown,
} from "../company-mail.ts";
import { mailList, mailRow, mailSummary } from "../interface-mail.ts";
import type { QuotedText } from "../quotes.ts";
import { messageText, show } from "./interface.ts";

/* The Mailbox page, drawn as a mail app draws an inbox (the 21 Oct 2026 rebuild; design canvas "Qorpera Mail", v3):
 * Inbox, Sent and Addresses as plain tabs, one line per thread, and no boxes. The page's definition (the cloud client's
 * library) still names it, gives it its rail row and badge and decides who sees it; this view draws it from the
 * company's mail as app/company-mail.ts reads it, not from the definition's blocks.
 *
 * - Inbox: the sends that wait for a person first ("Waiting for you", with Send and Don't send on the line), then every
 *   other thread, newest first. A line shows who wrote, the subject, the start of the newest message (`snippet`), the
 *   agent who handles it (grey while the thread is new) and when. Search narrows the lines read so far.
 * - A thread: its messages oldest first, each folded to one line but the newest, the sends waiting in it, and a line
 *   to tell the handling agent what to answer. That note goes as the member's own message, with the email's subject
 *   and sender as quotes (contract, "quoted outside content in a member's message").
 * - Sent: the threads whose newest message the company sent. Addresses: each address, who answers it, how much came in
 *   the last 7 days, and Change, which asks the Co-Founder to give it to another agent.
 * - Write: a member asks an agent to write an email; the agent writes and sends it, and its review decides as for any
 *   send.
 *
 * - Digital Post (deploy/first-node/RUNTIME-DIGITAL-POST.md): the letters the company folder holds from public
 *   authorities are lines of the Inbox among the threads, newest first, each with the authority as its sender and a
 *   Digital Post mark. A letter opens to its text and its documents (which open in Storage), with a line to ask an agent
 *   about it. Addresses has a Digital Post row, and its Choose asks the Co-Founder to give it an agent. The Mailbox shows
 *   while the company has an email address, or Digital Post connected or holding letters.
 *
 * What came from outside the company (a sender, a subject, a snippet, a message's text) is only ever set as text, and
 * carries the title that says so. Account mail shows only that it is account mail, for which site, who used the
 * account and when. */

type Tab = "inbox" | "sent" | "addresses";

const INBOX: MailListRequest = {};
const SENT: MailListRequest = { direction: "sent" };
const TOAST_MS = 4000;

interface MailboxUi {
	readonly profileId: string;
	tab: Tab;
	open: string | null;
	/** The open Digital Post letter, by its folder. */
	letter: string | null;
	/** Who a note about the open letter goes to; the Co-Founder until the member picks another. */
	letterAgent: string | null;
	search: string;
	/** Messages opened or folded by the member, by `thread:kind:id`; the rest follow the default (the newest open). */
	expanded: Record<string, boolean>;
	writing: boolean;
	writer: string | null;
	writeTo: string;
	writeText: string;
	note: string;
	changing: string | null;
	busy: boolean;
	error: string | null;
	toast: { readonly text: string; readonly agent: string | null; readonly id: number } | null;
}

const uis = new WeakMap<HTMLElement, MailboxUi>();
let toastIds = 0;

export interface MailboxOptions {
	/** Opens Settings on Company connections, where the company's addresses are made. */
	readonly openSettings?: () => void;
}

/** Draws the Mailbox page `name` into `container` (views/interface.ts routes it here); `moveFocus` names the control
 * that takes the focus once it is drawn (`show`). */
export function renderMailbox(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	options: MailboxOptions = {},
	moveFocus?: string,
): void {
	const profileId = company.profile.profileId;
	let ui = uis.get(container);
	if (!ui || ui.profileId !== profileId) {
		ui = {
			profileId,
			tab: "inbox",
			open: null,
			letter: null,
			letterAgent: null,
			search: "",
			expanded: {},
			writing: false,
			writer: null,
			writeTo: "",
			writeText: "",
			note: "",
			changing: null,
			busy: false,
			error: null,
			toast: null,
		};
		uis.set(container, ui);
	}
	const state = company.store.get();
	const mail = state.mail;
	const stillShown = () => {
		const shown = container.firstElementChild;
		return shown instanceof HTMLElement && shown.dataset.interface === name && shown.dataset.profile === profileId;
	};
	const redraw = (focus?: string) => {
		if (stillShown()) renderMailbox(container, company, name, options, focus);
	};
	const request = ui.tab === "sent" ? SENT : INBOX;
	const lists = ui.tab === "addresses" ? [] : [request];
	const threads = ui.open ? [ui.open] : [];
	const letters = ui.letter ? [ui.letter] : [];
	const staff = state.staff.map((agent) => [agent.id, agent.displayName, agent.employmentStatus, agent.appearance]);
	const key = JSON.stringify([
		profileId,
		company.userId,
		presentationLocale(),
		presentationTimeZone(),
		new Date().toDateString(),
		name,
		{ ...ui, toast: ui.toast?.id ?? null },
		state.team?.capabilities.write === true,
		company.cofounderId() ?? null,
		staff,
		mail
			? [
					mail.addresses,
					mail.waiting,
					mail.answers,
					lists.map((each) => mail.lists[mailListKey(each)] ?? null),
					threads.map((thread) => [mail.threads[thread] ?? null, mailSummary(company, thread) ?? null]),
					digitalPostOf(mail).connection ?? null,
					digitalPostOf(mail).letters,
					letters.map((letter) => digitalPostOf(mail).open[letter] ?? null),
				]
			: null,
	]);
	const page: Page = { company, ui, name, profileId, redraw, options };
	show(container, key, () => drawPage(page), moveFocus);
	CompanyMail.of(company)?.watch(lists, threads, stillShown, letters);
}

interface Page {
	readonly company: CompanyController;
	readonly ui: MailboxUi;
	readonly name: string;
	readonly profileId: string;
	readonly redraw: (moveFocus?: string) => void;
	readonly options: MailboxOptions;
}

const canWrite = (page: Page) => page.company.store.get().team?.capabilities.write === true;

/** An agent's name as the company knows it now, else as the mail named it. */
function agentName(page: Page, agentId: string | undefined, given?: string): string {
	return page.company.staffById(agentId)?.displayName || given || t("An agent");
}

function activeAgent(page: Page, agentId: string | undefined): HostedStaffAgent | undefined {
	const agent = page.company.staffById(agentId);
	return agent?.employmentStatus === "active" ? agent : undefined;
}

function figure(page: Page, agentId: string | undefined, given: string | undefined, size: number): HTMLElement {
	return agentFigure(page.company.staffById(agentId), given ?? "", { size });
}

/** Words from outside the company: set as text, with the title that says where they came from. */
function outside(text: string, tag: keyof HTMLElementTagNameMap = "span", className?: string): HTMLElement {
	return h(tag, { ...(className ? { class: className } : {}), title: t("From outside the company") }, text);
}

/** When a line's mail came: the time today, else the day (with the year, from another year). */
function when(at: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	const timeZone = presentationTimeZone();
	const dayOf = (moment: Date) => moment.toLocaleDateString("en-CA", { timeZone });
	const day = dayOf(date);
	const today = dayOf(new Date());
	if (day === today)
		return date.toLocaleTimeString(presentationLocale(), { hour: "2-digit", minute: "2-digit", timeZone });
	return date.toLocaleDateString(
		presentationLocale(),
		day.slice(0, 4) === today.slice(0, 4)
			? { month: "short", day: "numeric", timeZone }
			: { year: "numeric", month: "short", day: "numeric", timeZone },
	);
}

function say(page: Page, text: string, agent: string | null): void {
	const id = ++toastIds;
	page.ui.toast = { text, agent, id };
	page.redraw();
	setTimeout(() => {
		if (page.ui.toast?.id !== id) return;
		page.ui.toast = null;
		page.redraw();
	}, TOAST_MS);
}

/** The agent who answers a thread: the one that handled it, else the one its address names, else the Co-Founder. */
function threadAgent(page: Page, summary: MailThreadSummary | undefined): string | undefined {
	const handler = summary?.handledBy?.staffAgentId;
	if (activeAgent(page, handler)) return handler;
	const address = page.company.store.get().mail?.addresses.find((item) => item.address === summary?.address);
	const named = address?.handledBy.find((agent) => activeAgent(page, agent.staffAgentId));
	return named?.staffAgentId ?? page.company.cofounderId();
}

// The page --------------------------------------------------------------------------------------------------------

function drawPage(page: Page): HTMLElement {
	const { ui, company } = page;
	const mail = company.store.get().mail;
	const off = mail !== undefined && !mailShown(mail);
	const body = !mail
		? spinner(t("Reading the mail"))
		: off
			? noAddress(page)
			: ui.letter
				? letterView(page, ui.letter)
				: ui.open
					? threadView(page, ui.open)
					: ui.tab === "addresses"
						? addressesView(page)
						: listView(page);
	return h(
		"section",
		{ class: "mailbox", "data-interface": page.name, "data-profile": page.profileId },
		off ? null : bar(page),
		ui.error ? notice("danger", ui.error) : null,
		h(
			"div",
			{
				class: "mailbox-scroll",
				"data-scroll-key": JSON.stringify([page.profileId, ui.tab, ui.open, ui.letter]),
			},
			body,
		),
		ui.letter && mail && !off ? letterComposer(page, ui.letter) : null,
		ui.open && !ui.letter && mail && !off ? composer(page, ui.open) : null,
		ui.writing && canWrite(page) && mail && !off ? writePanel(page) : null,
		ui.toast ? toast(page, ui.toast.text, ui.toast.agent) : null,
	);
}

function bar(page: Page): HTMLElement {
	const { ui } = page;
	const waiting = waitingItems(page).length;
	const tabs: readonly [Tab, string][] = [
		["inbox", t("Inbox")],
		["sent", t("Sent")],
		["addresses", t("Addresses")],
	];
	return h(
		"header",
		{ class: "mailbox-bar" },
		h(
			"div",
			{ class: "mailbox-tabs", role: "tablist", "aria-label": t("Mailbox") },
			...tabs.map(([tab, label]) =>
				h(
					"button",
					{
						type: "button",
						role: "tab",
						class: "mailbox-tab",
						"aria-selected": String(ui.tab === tab),
						"data-focus-key": `tab:${tab}`,
						onclick: () => {
							ui.tab = tab;
							ui.open = null;
							ui.letter = null;
							ui.changing = null;
							page.redraw(`tab:${tab}`);
						},
					},
					label,
					tab === "inbox" && waiting > 0
						? h(
								"span",
								{ class: "mailbox-count", "aria-label": t("{count} waiting", { count: waiting }) },
								String(waiting),
							)
						: null,
				),
			),
		),
		h("span", { class: "mailbox-spacer" }),
		ui.tab === "addresses" && !ui.open && !ui.letter
			? null
			: h(
					"label",
					{ class: "mailbox-search" },
					icon("search"),
					h("span", { class: "visually-hidden" }, t("Search mail")),
					h("input", {
						type: "search",
						placeholder: t("Search"),
						value: ui.search,
						"data-focus-key": "search",
						oninput: (event: Event) => {
							ui.search = (event.target as HTMLInputElement).value;
							ui.open = null;
							ui.letter = null;
							page.redraw();
						},
					}),
				),
		canWrite(page) && (page.company.store.get().mail?.addresses.length ?? 0) > 0
			? h(
					"button",
					{
						type: "button",
						class: "mailbox-text mailbox-write",
						"data-focus-key": "write",
						onclick: () => {
							ui.writing = true;
							page.redraw("write-to");
						},
					},
					icon("edit"),
					t("Write"),
				)
			: null,
	);
}

function toast(page: Page, text: string, agent: string | null): HTMLElement {
	return h(
		"div",
		{ class: "mailbox-toast", role: "status" },
		agent ? figure(page, agent, undefined, 28) : null,
		h("span", null, text),
	);
}

function noAddress(page: Page): HTMLElement {
	const settings = page.options.openSettings;
	return h(
		"div",
		{ class: "mailbox-empty" },
		h("h1", null, t("The company has no email address yet")),
		h("p", null, t("Make one, and pick the agent who answers what comes in.")),
		h("p", null, t("Letters from public authorities come here too, once Digital Post is connected in Settings.")),
		settings && page.company.store.get().team?.capabilities.authorize === true
			? h("button", { type: "button", class: "mailbox-primary", onclick: settings }, t("Make an address"))
			: null,
	);
}

// The lists ---------------------------------------------------------------------------------------------------------

/** The sends waiting for a person, without those this member has just answered. */
function waitingItems(page: Page): readonly MailWaitingItem[] {
	const mail = page.company.store.get().mail;
	return (mail?.waiting ?? []).filter((item) => !mail?.answers[item.reviewId]?.answered);
}

function matches(search: string, ...words: (string | undefined)[]): boolean {
	const asked = search.trim().toLocaleLowerCase(presentationLocale());
	if (!asked) return true;
	return words.some((word) => word?.toLocaleLowerCase(presentationLocale()).includes(asked));
}

function listView(page: Page): HTMLElement {
	const { ui, company } = page;
	const mail = company.store.get().mail;
	const request = ui.tab === "sent" ? SENT : INBOX;
	const list = mailList(company, request);
	if (!list) return spinner(t("Reading the mail"));
	// An answered send keeps its line until the waiting list is read again, while it slides away (`is-leaving`).
	const waiting = ui.tab === "inbox" ? (mail?.waiting ?? []) : [];
	const waitingThreads = new Set(waiting.flatMap((item) => (item.thread ? [item.thread] : [])));
	const summaries = new Map(list.threads.map((item) => [item.thread, item]));
	const waitingRows = waiting
		.filter((item) => {
			const summary = item.thread ? summaries.get(item.thread) : undefined;
			return matches(ui.search, item.subject, item.snippet, ...item.to, summary?.fromName, summary?.fromAddress);
		})
		.map((item) => waitingLine(page, item, item.thread ? summaries.get(item.thread) : undefined));
	const rest = list.threads.filter(
		(item) =>
			!waitingThreads.has(item.thread) &&
			matches(ui.search, item.fromName, item.fromAddress, item.subject, item.snippet, item.address),
	);
	// Digital Post's letters join the Inbox by when they came, as far back as its threads are read.
	const oldest = list.next ? list.threads.at(-1)?.lastAt : undefined;
	const letters =
		ui.tab === "inbox"
			? digitalPostOf(mail).letters.filter(
					(letter) =>
						(oldest === undefined || Date.parse(letter.received) >= Date.parse(oldest)) &&
						matches(ui.search, letter.sender, letter.title, letter.snippet, letter.caseId),
				)
			: [];
	const rows = [
		...rest.map((item) => ({ at: Date.parse(item.lastAt), row: threadLine(page, item) })),
		...letters.map((letter) => ({ at: Date.parse(letter.received), row: letterLine(page, letter) })),
	]
		.sort((a, b) => b.at - a.at)
		.map((entry) => entry.row);
	if (list.status === "ready" && !rows.length && !waitingRows.length && !list.next) {
		if (ui.search.trim()) return h("p", { class: "mailbox-none" }, t("No mail matches."));
		if (ui.tab === "sent") return h("p", { class: "mailbox-none" }, t("Nothing has been sent yet."));
		return fresh(page, mail?.addresses ?? []);
	}
	return h(
		"div",
		{ class: "mailbox-list" },
		waitingRows.length
			? h(
					"section",
					{ "aria-labelledby": "mailbox-waiting" },
					h("h2", { id: "mailbox-waiting", class: "mailbox-section is-waiting" }, t("Waiting for you")),
					h("ul", { class: "mailbox-lines" }, ...waitingRows),
				)
			: null,
		h(
			"section",
			{ "aria-label": ui.tab === "sent" ? t("Sent") : t("Everything else") },
			waitingRows.length && rows.length ? h("h2", { class: "mailbox-section" }, t("Everything else")) : null,
			list.status === "error" && !list.threads.length
				? notice(
						"danger",
						h("p", null, list.error ?? t("The mail can't be read right now.")),
						h(
							"button",
							{
								type: "button",
								class: "mailbox-text",
								onclick: () => CompanyMail.of(company)?.retry(mailListKey(request)),
							},
							t("Try again"),
						),
					)
				: null,
			rows.length ? h("ul", { class: "mailbox-lines" }, ...rows) : null,
			olderButton(page, list, request),
		),
	);
}

function fresh(page: Page, addresses: readonly MailAddress[]): HTMLElement {
	const [first] = addresses;
	if (!first)
		return h(
			"div",
			{ class: "mailbox-empty" },
			h("h1", null, t("No Digital Post yet")),
			h("p", null, t("Letters from public authorities come here as Digital Post delivers them.")),
		);
	const agent = first?.handledBy[0];
	return h(
		"div",
		{ class: "mailbox-empty" },
		agent ? figure(page, agent.staffAgentId, agent.name, 84) : null,
		h("h1", null, first ? t("{address} is ready", { address: first.address }) : t("No mail yet")),
		h(
			"p",
			null,
			agent
				? t("Nothing has arrived yet. {name} answers what comes in.", {
						name: agentName(page, agent.staffAgentId, agent.name),
					})
				: t("Nothing has arrived yet."),
		),
	);
}

function olderButton(page: Page, list: MailList, request: MailListRequest): HTMLElement | null {
	if (!list.next) return null;
	const loading = list.older === "loading";
	return h(
		"div",
		{ class: "mailbox-older" },
		list.older === "error" ? h("p", { role: "alert" }, t("Older mail can't be read.")) : null,
		h(
			"button",
			{
				type: "button",
				class: "mailbox-text",
				"data-focus-key": "older",
				disabled: loading,
				"aria-busy": loading ? "true" : null,
				onclick: () => CompanyMail.of(page.company)?.older(mailListKey(request)),
			},
			loading ? t("Reading older mail") : list.older === "error" ? t("Try again") : t("Show older"),
		),
	);
}

/** Who a thread is with: the outside party, and the agent too once the company has written in it. */
function partyText(summary: MailThreadSummary): string {
	return summary.fromName || summary.fromAddress || t("Unknown sender");
}

function accountSite(account: MailAccount | undefined): string {
	return account && !account.unknown && account.site ? account.site : t("unknown account");
}

/** Who last used an account, as its mail says; the handler of the mail may be another agent. */
function accountUse(page: Page, account: MailAccount): string {
	const used = account.unknown ? undefined : account.lastUsedBy;
	return used ? t("{name} used the account", { name: agentName(page, used) }) : t("Not known who used the account");
}

function openThread(page: Page, thread: string): void {
	page.ui.open = thread;
	page.ui.note = "";
	page.redraw("back");
}

function threadLine(page: Page, summary: MailThreadSummary): HTMLElement {
	const sent = page.ui.tab === "sent";
	const agentId = summary.handledBy?.staffAgentId;
	const agent = agentName(page, agentId, summary.handledBy?.name);
	const isNew = summary.state === "new";
	const unread = summary.unread && !sent;
	const who = summary.account
		? h("span", { class: "mailbox-who" }, icon("lock"), h("span", null, t("Account mail")))
		: h(
				"span",
				{ class: "mailbox-who" },
				sent ? h("span", { class: "mailbox-to-label" }, t("To:")) : null,
				outside(partyText(summary)),
				summary.direction === "sent" && !sent && summary.handledBy ? h("span", null, `, ${agent}`) : null,
				summary.messages > 1 ? h("span", { class: "mailbox-n" }, String(summary.messages)) : null,
			);
	const line = summary.account
		? h(
				"span",
				{ class: "mailbox-line" },
				h("span", { class: "mailbox-subject" }, accountSite(summary.account)),
				h("span", { class: "mailbox-snippet" }, ` — ${accountUse(page, summary.account)}`),
			)
		: h(
				"span",
				{ class: "mailbox-line" },
				isNew && !sent ? h("span", { class: "mailbox-state is-new" }, t("New")) : null,
				outside(summary.subject || t("(no subject)"), "span", "mailbox-subject"),
				summary.snippet
					? summary.direction === "sent"
						? h("span", { class: "mailbox-snippet" }, ` — ${agent}: `, outside(summary.snippet))
						: h("span", { class: "mailbox-snippet" }, " — ", outside(summary.snippet))
					: null,
			);
	return h(
		"li",
		{ class: `mailbox-row${unread ? " is-unread" : ""}` },
		h(
			"button",
			{
				type: "button",
				class: "mailbox-open",
				"data-focus-key": `row:${summary.thread}`,
				onclick: () => openThread(page, summary.thread),
			},
			h("span", { class: "mailbox-dot", "aria-hidden": "true" }),
			unread ? h("span", { class: "visually-hidden" }, t("Unread")) : null,
			who,
			line,
		),
		h("span", { class: "mailbox-actions" }),
		agentId
			? h(
					"span",
					{
						class: `mailbox-handler${isNew ? " is-new" : ""}`,
						title: isNew
							? t("{name} hasn't handled it yet", { name: agent })
							: t("{name} handles it", { name: agent }),
					},
					figure(page, agentId, summary.handledBy?.name, 26),
				)
			: h("span", { class: "mailbox-handler" }),
		h("time", { class: "mailbox-time", datetime: summary.lastAt }, when(summary.lastAt)),
	);
}

/** Send and Don't send for a waiting send, where this member may answer it; else why not. */
function answerButtons(
	page: Page,
	thread: string | undefined,
	reviewId: string,
	sessionId: string | undefined,
): HTMLElement[] {
	const mail = page.company.store.get().mail;
	const given = mail?.answers[reviewId];
	if (!sessionId || !canWrite(page)) return [];
	const pending = given?.pending === true;
	const answer = (choice: "allow_once" | "deny") => () =>
		void CompanyMail.of(page.company)?.answer(thread, sessionId, reviewId, choice);
	return [
		h(
			"button",
			{
				type: "button",
				class: "mailbox-text is-quiet",
				disabled: pending,
				"data-focus-key": `deny:${reviewId}`,
				onclick: answer("deny"),
			},
			t("Don't send"),
		),
		h(
			"button",
			{
				type: "button",
				class: "mailbox-text is-send",
				disabled: pending,
				"data-focus-key": `send:${reviewId}`,
				onclick: answer("allow_once"),
			},
			t("Send"),
		),
	];
}

/** An agent's thread, while the agent is at work. */
function agentHref(page: Page, agentId: string | undefined): string | null {
	const agent = activeAgent(page, agentId);
	if (!agent) return null;
	return agent.id === page.company.cofounderId() ? `#/c/${page.profileId}` : `#/c/${page.profileId}/staff/${agent.id}`;
}

/** What went wrong with an answer, and the agent's thread when the answer needs the member's model account there. */
function answerError(page: Page, reviewId: string, agentId: string | undefined, given?: string): HTMLElement | null {
	const answer = page.company.store.get().mail?.answers[reviewId];
	if (!answer?.error) return null;
	const name = agentName(page, agentId, given);
	const href = agentHref(page, agentId);
	return h(
		"p",
		{ class: "mailbox-error", role: "alert" },
		answer.needsAccount && href
			? t("This answer needs your model account. Answer it in {name}'s thread, where you can choose one.", { name })
			: answer.error,
		answer.needsAccount && href ? h("a", { href }, ` ${t("Open {name}'s thread", { name })}`) : null,
	);
}

function waitingLine(page: Page, item: MailWaitingItem, summary: MailThreadSummary | undefined): HTMLElement {
	const agentId = item.staffAgent?.staffAgentId;
	const agent = agentName(page, agentId, item.staffAgent?.name);
	const answered = page.company.store.get().mail?.answers[item.reviewId]?.answered !== undefined;
	const to = summary ? partyText(summary) : (item.to[0] ?? t("New email"));
	const href = agentHref(page, agentId);
	const recipients = [
		item.to.length ? t("to {who}", { who: item.to.join(", ") }) : null,
		item.cc.length ? t("cc {who}", { who: item.cc.join(", ") }) : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	const content = [
		h("span", { class: "mailbox-dot", "aria-hidden": "true" }),
		h(
			"span",
			{ class: "mailbox-who" },
			summary ? outside(to) : h("span", null, to),
			summary && summary.messages > 1 ? h("span", { class: "mailbox-n" }, String(summary.messages)) : null,
		),
		h(
			"span",
			{ class: "mailbox-line" },
			h("span", { class: "mailbox-state is-waiting" }, t("Waiting for you")),
			// Every recipient the send goes to shows on the line it is answered from: a reply may go to someone other
			// than the thread's sender.
			recipients ? h("span", { class: "mailbox-recipients", title: recipients }, recipients) : null,
			h("span", { class: "mailbox-subject" }, item.subject || summary?.subject || t("(no subject)")),
			item.snippet ? h("span", { class: "mailbox-snippet" }, ` — ${agent}: ${item.snippet}`) : null,
		),
	];
	const thread = item.thread;
	return h(
		"li",
		{ class: `mailbox-row is-waiting${answered ? " is-leaving" : ""}` },
		thread
			? h(
					"button",
					{
						type: "button",
						class: "mailbox-open",
						"data-focus-key": `row:${item.reviewId}`,
						onclick: () => openThread(page, thread),
					},
					...content,
				)
			: href
				? // A new email has no thread: its whole card waits in the agent's conversation.
					h(
						"a",
						{
							class: "mailbox-open",
							href,
							title: t("Open {name}'s thread", { name: agent }),
							"data-focus-key": `row:${item.reviewId}`,
						},
						...content,
					)
				: h("span", { class: "mailbox-open" }, ...content),
		h("span", { class: "mailbox-actions" }, ...answerButtons(page, thread, item.reviewId, item.sessionId)),
		h(
			"span",
			{ class: "mailbox-handler", title: t("{name} wants to send this", { name: agent }) },
			figure(page, agentId, item.staffAgent?.name, 26),
		),
		h("time", { class: "mailbox-time", datetime: item.createdAt }, when(item.createdAt)),
		answerError(page, item.reviewId, agentId, item.staffAgent?.name),
	);
}

// A thread ----------------------------------------------------------------------------------------------------------

const messageKey = (thread: string, message: MailMessage) => `${thread}:${message.kind}:${message.id}`;

function initials(name: string): string {
	return [...name.trim().split(/\s+/)]
		.map((part) => [...part][0] ?? "")
		.slice(0, 2)
		.join("")
		.toLocaleUpperCase(presentationLocale());
}

function threadView(page: Page, thread: string): HTMLElement {
	const { company, ui } = page;
	const read = company.store.get().mail?.threads[thread];
	const summary = mailSummary(company, thread);
	const handler = summary?.handledBy?.staffAgentId;
	const account = summary?.account;
	const title = account
		? h("h1", null, `${t("Account mail")} · ${accountSite(account)}`)
		: outside(summary?.subject || t("(no subject)"), "h1");
	const back = h(
		"button",
		{
			type: "button",
			class: "mailbox-icon",
			"aria-label": ui.tab === "sent" ? t("Back to Sent") : t("Back to Inbox"),
			"data-focus-key": "back",
			onclick: () => {
				ui.open = null;
				page.redraw(`row:${thread}`);
			},
		},
		icon("back"),
	);
	const head = h(
		"header",
		{ class: "mailbox-thread-head" },
		title,
		summary ? h("span", { class: "mailbox-muted" }, summary.address) : null,
		handler
			? h(
					"span",
					{ class: "mailbox-muted mailbox-handled" },
					figure(page, handler, summary?.handledBy?.name, 22),
					t("{name} handles it", { name: agentName(page, handler, summary?.handledBy?.name) }),
				)
			: null,
	);
	const parts: (HTMLElement | null)[] = [h("div", { class: "mailbox-back" }, back), head];
	if (read === undefined) parts.push(spinner(t("Reading the email")));
	else if (read.status === "gone")
		parts.push(h("p", { class: "mailbox-none" }, t("This email thread is no longer here.")));
	else if (read.status === "error")
		parts.push(
			notice(
				"danger",
				h("p", null, read.error),
				h(
					"button",
					{ type: "button", class: "mailbox-text", onclick: () => CompanyMail.of(company)?.retryThread(thread) },
					t("Try again"),
				),
			),
		);
	else {
		const shown = read.thread;
		const loading = read.older === "loading";
		if (shown.more)
			parts.push(
				h(
					"div",
					{ class: "mailbox-older" },
					read.older === "error" ? h("p", { role: "alert" }, t("Older messages can't be read.")) : null,
					h(
						"button",
						{
							type: "button",
							class: "mailbox-text",
							disabled: loading,
							"aria-busy": loading ? "true" : null,
							"data-focus-key": "older-messages",
							onclick: () => CompanyMail.of(company)?.olderMessages(thread),
						},
						loading ? t("Reading older messages") : t("Show older messages"),
					),
				),
			);
		const last = shown.messages.at(-1);
		parts.push(
			h(
				"ol",
				{ class: "mailbox-messages" },
				...shown.messages.map((message) => messageItem(page, thread, message, message === last, summary)),
			),
			...shown.waiting.map((send) => draftItem(page, thread, send)),
		);
	}
	return h("div", { class: "mailbox-thread" }, ...parts);
}

function senderOf(message: MailMessage): string {
	return [message.fromName, message.fromAddress && message.fromName ? `<${message.fromAddress}>` : message.fromAddress]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ");
}

function messageItem(
	page: Page,
	thread: string,
	message: MailMessage,
	newest: boolean,
	summary: MailThreadSummary | undefined,
): HTMLElement {
	const { ui } = page;
	const received = message.kind === "received";
	if (received && message.account) {
		const account = message.account;
		const used = account.unknown ? undefined : account.lastUsedBy;
		return h(
			"li",
			{ class: "mailbox-message is-account" },
			h("span", { class: "mailbox-lock", "aria-hidden": "true" }, icon("lock")),
			h(
				"span",
				null,
				account.unknown
					? t("Account mail (unknown account)")
					: used
						? t("{name} used the account", { name: agentName(page, used) })
						: t("Account mail"),
			),
			h("time", { class: "mailbox-time", datetime: message.at }, when(message.at)),
		);
	}
	const key = messageKey(thread, message);
	const open = ui.expanded[key] ?? newest;
	const toggle = () => {
		ui.expanded = { ...ui.expanded, [key]: !open };
		page.redraw(`message:${key}`);
	};
	const agentId = received ? undefined : message.staffAgent?.staffAgentId;
	const agent = received ? "" : agentName(page, agentId, message.staffAgent?.name);
	const sender = senderOf(message);
	const name = received ? message.fromName || message.fromAddress || t("Unknown sender") : agent || sender;
	const avatar = received
		? h("span", { class: "mailbox-initials", "aria-hidden": "true" }, initials(name) || "?")
		: figure(page, agentId, message.staffAgent?.name, 40);
	const text = message.text ?? "";
	const flat = text.replace(/\s+/g, " ").trim();
	if (!open)
		return h(
			"li",
			{ class: "mailbox-message is-folded" },
			h(
				"button",
				{
					type: "button",
					class: "mailbox-fold",
					"aria-expanded": "false",
					"data-focus-key": `message:${key}`,
					onclick: toggle,
				},
				avatar,
				received ? outside(name, "strong") : h("strong", null, name),
				received ? outside(flat, "span", "mailbox-snippet") : h("span", { class: "mailbox-snippet" }, flat),
				h("time", { class: "mailbox-time", datetime: message.at }, when(message.at)),
			),
		);
	const status = received
		? null
		: message.status === "sent"
			? h("span", { class: "mailbox-status" }, t("Sent"))
			: message.status === "failed"
				? h("span", { class: "mailbox-status is-failed" }, t("Not sent"))
				: message.status === "cancelled"
					? h("span", { class: "mailbox-status is-failed" }, t("Cancelled"))
					: h("span", { class: "mailbox-status" }, t("Sending"));
	const notes = [
		received && message.automated ? t("Automated email") : null,
		received && message.textTruncated ? t("This email is longer; only its start is shown.") : null,
		message.textCleared ? t("This email's text is no longer kept.") : null,
	].filter((note): note is string => note !== null);
	const files = message.attachments.map((attachment) => attachment.filename).join(", ");
	const to = received ? summary?.address : message.to.join(", ");
	return h(
		"li",
		{ class: "mailbox-message" },
		avatar,
		h(
			"div",
			{ class: "mailbox-message-body" },
			h(
				"button",
				{
					type: "button",
					class: "mailbox-message-head",
					"aria-expanded": "true",
					"data-focus-key": `message:${key}`,
					onclick: toggle,
				},
				h(
					"span",
					{ class: "mailbox-from" },
					received ? outside(name, "strong") : h("strong", null, name),
					received && message.fromAddress && message.fromName
						? outside(`<${message.fromAddress}>`, "span", "mailbox-muted")
						: null,
					received
						? h("span", { class: "mailbox-muted", title: t("From outside the company") }, `· ${t("outside")}`)
						: null,
					to ? h("span", { class: "mailbox-to" }, t("to {who}", { who: to })) : null,
				),
				h("span", { class: "mailbox-when" }, status, h("time", { datetime: message.at }, fmtTime(message.at))),
			),
			notes.length ? h("p", { class: "mailbox-note" }, notes.join(" ")) : null,
			text
				? received
					? outside(text, "p", "mailbox-text-body")
					: h("p", { class: "mailbox-text-body" }, text)
				: null,
			files
				? h("p", { class: "mailbox-files" }, icon("attach"), received ? outside(files) : h("span", null, files))
				: null,
		),
	);
}

function draftItem(page: Page, thread: string, send: MailWaitingSend): HTMLElement {
	const agentId = send.staffAgent?.staffAgentId;
	const agent = agentName(page, agentId, send.staffAgent?.name);
	const given = page.company.store.get().mail?.answers[send.reviewId];
	const buttons = given?.answered ? [] : answerButtons(page, thread, send.reviewId, send.sessionId);
	const files = send.attachments.map((attachment) => attachment.filename).join(", ");
	return h(
		"div",
		{ class: `mailbox-draft${given?.answered ? " is-leaving" : ""}`, "data-review-id": send.reviewId },
		figure(page, agentId, send.staffAgent?.name, 40),
		h(
			"div",
			{ class: "mailbox-message-body" },
			h(
				"div",
				{ class: "mailbox-draft-head" },
				h("strong", null, t("{name} wants to send this", { name: agent })),
				send.to.length ? h("span", { class: "mailbox-muted" }, t("to {who}", { who: send.to.join(", ") })) : null,
			),
			send.cc.length ? h("p", { class: "mailbox-draft-field" }, t("cc {who}", { who: send.cc.join(", ") })) : null,
			h("p", { class: "mailbox-draft-field is-subject" }, send.subject || t("(no subject)")),
			send.text ? h("p", { class: "mailbox-text-body" }, send.text) : null,
			files ? h("p", { class: "mailbox-files" }, icon("attach"), h("span", null, files)) : null,
			buttons.length
				? h("div", { class: "mailbox-draft-actions" }, ...buttons.reverse())
				: given?.answered
					? null
					: h("p", { class: "mailbox-note" }, t("This send waits for someone who can answer it.")),
			answerError(page, send.reviewId, agentId, send.staffAgent?.name),
		),
	);
}

/** "Tell Ida what to answer": the member's own words, after the email's subject and sender as quotes. */
function composer(page: Page, thread: string): HTMLElement | null {
	const { company, ui } = page;
	const summary = mailSummary(company, thread);
	if (!canWrite(page) || !summary || summary.account) return null;
	const agentId = threadAgent(page, summary);
	if (!agentId) return null;
	const agent = agentName(page, agentId);
	const placeholder = t("Tell {name} what to answer", { name: agent });
	const send = async () => {
		const words = ui.note.trim();
		if (!words || ui.busy) return;
		const quoted = messageText(
			t("About the email {subject} from {from_name}: "),
			mailRow(summary),
			"mail",
			(_column, value) => String(value ?? ""),
		);
		if (!quoted) return;
		const note: QuotedText = { text: `${quoted.text}${words}`, quotes: quoted.quotes };
		await tell(page, agentId, note, t("{name} has your note", { name: agent }), () => {
			ui.note = "";
		});
	};
	return h(
		"form",
		{
			class: "mailbox-composer",
			onsubmit: (event: Event) => {
				event.preventDefault();
				void send();
			},
		},
		figure(page, agentId, undefined, 36),
		h("label", { class: "visually-hidden", for: "mailbox-note" }, placeholder),
		h("input", {
			id: "mailbox-note",
			placeholder,
			value: ui.note,
			disabled: ui.busy,
			autocomplete: "off",
			"data-focus-key": "note",
			oninput: (event: Event) => {
				ui.note = (event.target as HTMLInputElement).value;
			},
		}),
		h(
			"button",
			{
				type: "submit",
				class: "mailbox-icon",
				"aria-label": t("Send to {name}", { name: agent }),
				disabled: ui.busy,
			},
			icon("send"),
		),
	);
}

/** Sends a note through the company's mail reader; a note that can't go from here waits in the agent's thread. */
async function tell(page: Page, agentId: string, note: QuotedText, done: string, onSent: () => void): Promise<void> {
	const { ui } = page;
	const reader = CompanyMail.of(page.company);
	if (!reader) return;
	ui.busy = true;
	ui.error = null;
	page.redraw();
	try {
		const result = await reader.tell(agentId, note);
		onSent();
		ui.busy = false;
		if (result.sent) say(page, done, agentId);
		else location.hash = result.href;
	} catch (error) {
		ui.busy = false;
		ui.error = error instanceof Error ? error.message : String(error);
	}
	page.redraw();
}

// Digital Post ------------------------------------------------------------------------------------------------------

function openLetter(page: Page, folder: string): void {
	page.ui.letter = folder;
	page.ui.open = null;
	page.ui.note = "";
	page.redraw("back");
}

function letterOf(page: Page, folder: string): DigitalPostLetter | undefined {
	return digitalPostOf(page.company.store.get().mail).letters.find((letter) => letter.folder === folder);
}

/** A letter's line in the Inbox: the authority that sent it, its title, the start of its text, the Digital Post mark. */
function letterLine(page: Page, letter: DigitalPostLetter): HTMLElement {
	return h(
		"li",
		{ class: "mailbox-row is-letter" },
		h(
			"button",
			{
				type: "button",
				class: "mailbox-open",
				"data-focus-key": `letter:${letter.messageUuid}`,
				onclick: () => openLetter(page, letter.folder),
			},
			h("span", { class: "mailbox-dot", "aria-hidden": "true" }),
			h("span", { class: "mailbox-who" }, outside(letter.sender)),
			h(
				"span",
				{ class: "mailbox-line" },
				letter.legalNotification ? h("span", { class: "mailbox-state is-legal" }, t("Legal effect")) : null,
				outside(letter.title, "span", "mailbox-subject"),
				letter.snippet ? h("span", { class: "mailbox-snippet" }, " — ", outside(letter.snippet)) : null,
			),
		),
		h("span", { class: "mailbox-actions" }),
		h("span", { class: "mailbox-handler mailbox-post", title: t("Digital Post") }, icon("company")),
		h("time", { class: "mailbox-time", datetime: letter.received }, when(letter.received)),
	);
}

/** An open letter: who sent it and when, its flags, its text, and its documents, which open in Storage. */
function letterView(page: Page, folder: string): HTMLElement {
	const { company, ui } = page;
	const letter = letterOf(page, folder);
	const read = digitalPostOf(company.store.get().mail).open[folder];
	const back = h(
		"button",
		{
			type: "button",
			class: "mailbox-icon",
			"aria-label": t("Back to Inbox"),
			"data-focus-key": "back",
			onclick: () => {
				ui.letter = null;
				page.redraw(letter ? `letter:${letter.messageUuid}` : undefined);
			},
		},
		icon("back"),
	);
	const flags = letter
		? [
				letter.legalNotification ? t("Legal effect") : null,
				letter.mandatory ? t("Mandatory post") : null,
				letter.replyBy ? t("Reply by {when}", { when: fmtTime(letter.replyBy) }) : null,
				letter.caseId ? t("Case {id}", { id: letter.caseId }) : null,
			].filter((flag): flag is string => flag !== null)
		: [];
	const head = h(
		"header",
		{ class: "mailbox-thread-head" },
		letter ? outside(letter.title, "h1") : h("h1", null, t("Digital Post")),
		letter
			? h(
					"span",
					{ class: "mailbox-muted mailbox-handled" },
					icon("company"),
					outside(letter.sender),
					` · ${t("Digital Post")} · ${fmtTime(letter.received)}`,
				)
			: null,
		flags.length ? h("span", { class: "mailbox-muted mailbox-flags" }, flags.join(" · ")) : null,
	);
	const parts: (HTMLElement | null)[] = [h("div", { class: "mailbox-back" }, back), head];
	if (read === undefined) parts.push(spinner(t("Reading the letter")));
	else if (read.status === "gone")
		parts.push(h("p", { class: "mailbox-none" }, t("This letter is no longer in the company folder.")));
	else if (read.status === "large")
		parts.push(
			h(
				"p",
				{ class: "mailbox-none" },
				t("This letter is too long to show here. Open its folder to read it and its documents."),
			),
		);
	else if (read.status === "error") parts.push(notice("danger", h("p", null, read.error)));
	else {
		parts.push(
			read.letter.text
				? outside(read.letter.text, "div", "mailbox-letter-text")
				: h("p", { class: "mailbox-muted" }, t("The letter's text is in its documents.")),
		);
		if (read.letter.documents.length)
			parts.push(
				h(
					"ul",
					{ class: "mailbox-documents", "aria-label": t("Documents") },
					...read.letter.documents.map((name) =>
						h(
							"li",
							null,
							h(
								"button",
								{ type: "button", class: "mailbox-text", "data-folder-path": `${folder}/${name}` },
								icon("file"),
								outside(name),
							),
						),
					),
				),
			);
	}
	parts.push(
		h(
			"p",
			{ class: "mailbox-muted mailbox-folder" },
			h(
				"button",
				{ type: "button", class: "mailbox-text is-quiet", "data-folder-path": folder },
				icon("folder"),
				t("Open the letter's folder"),
			),
		),
	);
	return h("div", { class: "mailbox-thread is-letter" }, ...parts);
}

/** A note about the open letter to an agent the member picks (the Co-Founder at first), with the letter as quotes. */
function letterComposer(page: Page, folder: string): HTMLElement | null {
	const { company, ui } = page;
	const letter = letterOf(page, folder);
	if (!canWrite(page) || !letter) return null;
	const cofounder = company.cofounderId();
	const agents = company.store.get().staff.filter((agent) => agent.employmentStatus === "active");
	const agentId =
		ui.letterAgent && agents.some((agent) => agent.id === ui.letterAgent)
			? ui.letterAgent
			: (cofounder ?? agents[0]?.id);
	if (!agentId) return null;
	const agent = agentName(page, agentId);
	const placeholder = t("Tell {name} what to do with this letter", { name: agent });
	const send = async () => {
		const words = ui.note.trim();
		if (!words || ui.busy) return;
		// The letter is named by its message id and its year's folder, never by its title or sender: those are an
		// authority's words, and a member's message quotes outside words only from email (contract, "quoted outside
		// content in a member's message").
		const note: QuotedText = {
			text: `${t("About the Digital Post letter {id} (its folder in {folder} ends with its id): ", {
				id: letter.messageUuid,
				folder: folder.split("/").slice(0, 2).join("/"),
			})}${words}`,
			quotes: [],
		};
		await tell(page, agentId, note, t("{name} has your note", { name: agent }), () => {
			ui.note = "";
		});
	};
	return h(
		"form",
		{
			class: "mailbox-composer",
			onsubmit: (event: Event) => {
				event.preventDefault();
				void send();
			},
		},
		h(
			"select",
			{
				class: "mailbox-agent-pick",
				"aria-label": t("Who the note goes to"),
				disabled: ui.busy,
				onchange: (event: Event) => {
					ui.letterAgent = (event.target as HTMLSelectElement).value;
					page.redraw("note");
				},
			},
			...agents.map((each) => h("option", { value: each.id, selected: each.id === agentId }, each.displayName)),
		),
		h("label", { class: "visually-hidden", for: "mailbox-note" }, placeholder),
		h("input", {
			id: "mailbox-note",
			placeholder,
			value: ui.note,
			disabled: ui.busy,
			autocomplete: "off",
			"data-focus-key": "note",
			oninput: (event: Event) => {
				ui.note = (event.target as HTMLInputElement).value;
			},
		}),
		h(
			"button",
			{
				type: "submit",
				class: "mailbox-icon",
				"aria-label": t("Send to {name}", { name: agent }),
				disabled: ui.busy,
			},
			icon("send"),
		),
	);
}

/** The Digital Post row of Addresses, while Digital Post is connected or holds letters: how it stands, and Choose,
 * which asks the Co-Founder to have an agent read the letters as they come. */
function digitalPostAddress(page: Page, agents: readonly HostedStaffAgent[]): HTMLElement | null {
	const { company, ui } = page;
	const post = digitalPostOf(company.store.get().mail);
	const connection = post.connection;
	if (!connection?.connected && !post.letters.length) return null;
	const cofounder = company.cofounderId();
	const choosing = ui.changing === "digital-post";
	const standing = !connection?.connected
		? t("Not connected")
		: connection.status === "refused"
			? t("Digital Post refused the key")
			: connection.status === "failed"
				? t("Not reached at the last try")
				: connection.status === "waiting"
					? t("Connecting")
					: connection.fetchedAt
						? t("Checked {when}", { when: when(connection.fetchedAt) })
						: t("Connected");
	return h(
		"li",
		{ class: "mailbox-address is-digital-post" },
		h(
			"div",
			{ class: "mailbox-address-row" },
			h(
				"span",
				{ class: "mailbox-address-name" },
				h("strong", null, icon("company"), t("Digital Post")),
				h("span", { class: "mailbox-muted" }, t("Letters from public authorities")),
			),
			h("span", { class: "mailbox-address-agent mailbox-muted" }, standing),
			h(
				"span",
				{ class: "mailbox-muted" },
				h("strong", { class: "mailbox-week" }, String(post.letters.length)),
				` ${post.letters.length === 1 ? t("letter") : t("letters")}`,
			),
			canWrite(page) && cofounder
				? h(
						"button",
						{
							type: "button",
							class: "mailbox-text is-quiet",
							"aria-expanded": String(choosing),
							"data-focus-key": "change:digital-post",
							onclick: () => {
								ui.changing = choosing ? null : "digital-post";
								page.redraw("change:digital-post");
							},
						},
						t("Choose who reads it"),
					)
				: null,
		),
		choosing && cofounder
			? h(
					"div",
					{ class: "mailbox-picks", role: "group", "aria-label": t("Who should read it?") },
					h("span", { class: "mailbox-muted" }, t("Who should read it?")),
					...agents.map((agent) =>
						h(
							"button",
							{
								type: "button",
								class: "mailbox-pick",
								disabled: ui.busy,
								onclick: () => {
									void tell(
										page,
										cofounder,
										{
											text: t(
												"Please have {name} read the company's Digital Post: a routine that wakes on new letters in digital-post/ (a file change, the whole folder), reads each letter's letter.md and acts on it.",
												{ name: agent.displayName },
											),
											quotes: [],
										},
										t("Asked {cofounder} to have {name} read Digital Post", {
											cofounder: agentName(page, cofounder),
											name: agent.displayName,
										}),
										() => {
											ui.changing = null;
										},
									);
								},
							},
							figure(page, agent.id, agent.displayName, 30),
							agent.displayName,
						),
					),
				)
			: null,
	);
}

// Addresses ---------------------------------------------------------------------------------------------------------

function addressesView(page: Page): HTMLElement {
	const { company, ui } = page;
	const mail = company.store.get().mail;
	const cofounder = company.cofounderId();
	const agents = company.store
		.get()
		.staff.filter((agent) => agent.employmentStatus === "active")
		.sort((a, b) => (a.id === cofounder ? -1 : b.id === cofounder ? 1 : a.displayName.localeCompare(b.displayName)));
	const rows = (mail?.addresses ?? []).map((address) => {
		const handler = address.handledBy[0];
		const changing = ui.changing === address.address;
		return h(
			"li",
			{ class: "mailbox-address" },
			h(
				"div",
				{ class: "mailbox-address-row" },
				h(
					"span",
					{ class: "mailbox-address-name" },
					h("strong", null, address.address),
					address.routines.length
						? h("span", { class: "mailbox-muted" }, address.routines.map((routine) => routine.title).join(", "))
						: null,
				),
				h(
					"span",
					{ class: "mailbox-address-agent" },
					handler ? figure(page, handler.staffAgentId, handler.name, 30) : null,
					handler
						? t("{name} answers it", { name: agentName(page, handler.staffAgentId, handler.name) })
						: t("No agent answers it yet"),
				),
				h(
					"span",
					{ class: "mailbox-muted" },
					h("strong", { class: "mailbox-week" }, String(address.last7Days)),
					` ${t("in the last 7 days")}`,
				),
				canWrite(page) && cofounder
					? h(
							"button",
							{
								type: "button",
								class: "mailbox-text is-quiet",
								"aria-expanded": String(changing),
								"data-focus-key": `change:${address.address}`,
								onclick: () => {
									ui.changing = changing ? null : address.address;
									page.redraw(`change:${address.address}`);
								},
							},
							t("Change"),
						)
					: null,
			),
			changing && cofounder
				? h(
						"div",
						{ class: "mailbox-picks", role: "group", "aria-label": t("Who should answer it?") },
						h("span", { class: "mailbox-muted" }, t("Who should answer it?")),
						...agents.map((agent) => {
							const current = address.handledBy.some((each) => each.staffAgentId === agent.id);
							return h(
								"button",
								{
									type: "button",
									class: `mailbox-pick${current ? " is-current" : ""}`,
									"aria-pressed": String(current),
									disabled: ui.busy,
									onclick: () => {
										if (current) {
											ui.changing = null;
											page.redraw();
											return;
										}
										const cofounderName = agentName(page, cofounder);
										void tell(
											page,
											cofounder,
											{
												text: t("Please have {name} answer the email that comes to {address}.", {
													name: agent.displayName,
													address: address.address,
												}),
												quotes: [],
											},
											t("Asked {cofounder} to give {address} to {name}", {
												cofounder: cofounderName,
												address: address.address,
												name: agent.displayName,
											}),
											() => {
												ui.changing = null;
											},
										);
									},
								},
								figure(page, agent.id, agent.displayName, 30),
								agent.displayName,
							);
						}),
					)
				: null,
		);
	});
	const post = digitalPostAddress(page, agents);
	return h(
		"div",
		{ class: "mailbox-addresses" },
		h("ul", { class: "mailbox-address-list" }, ...rows, ...(post ? [post] : [])),
		page.options.openSettings && company.store.get().team?.capabilities.authorize === true
			? h(
					"button",
					{ type: "button", class: "mailbox-text mailbox-new", onclick: page.options.openSettings },
					icon("plus"),
					t("New address"),
				)
			: null,
	);
}

// Write -------------------------------------------------------------------------------------------------------------

function writePanel(page: Page): HTMLElement {
	const { company, ui } = page;
	const mail = company.store.get().mail;
	const cofounder = company.cofounderId();
	// The agents who answer an address, then the Co-Founder.
	const writers: { id: string; address?: string }[] = [];
	for (const address of mail?.addresses ?? [])
		for (const agent of address.handledBy)
			if (activeAgent(page, agent.staffAgentId) && !writers.some((each) => each.id === agent.staffAgentId))
				writers.push({ id: agent.staffAgentId, address: address.address });
	if (cofounder && !writers.some((each) => each.id === cofounder)) writers.push({ id: cofounder });
	const chosen = writers.find((each) => each.id === ui.writer) ?? writers[0];
	const from = chosen?.address ?? mail?.addresses[0]?.address;
	const close = () => {
		ui.writing = false;
		page.redraw("write");
	};
	const submit = async () => {
		const to = ui.writeTo.trim();
		const words = ui.writeText.trim();
		if (!chosen || !to || !words || ui.busy) return;
		const name = agentName(page, chosen.id);
		await tell(
			page,
			chosen.id,
			{
				text: from
					? t("Please write an email to {to} from {from}: {words}", { to, from, words })
					: t("Please write an email to {to}: {words}", { to, words }),
				quotes: [],
			},
			t("{name} is writing it", { name }),
			() => {
				ui.writing = false;
				ui.writeTo = "";
				ui.writeText = "";
			},
		);
	};
	return h(
		"form",
		{
			class: "mailbox-write-panel",
			role: "dialog",
			"aria-labelledby": "mailbox-write-title",
			onsubmit: (event: Event) => {
				event.preventDefault();
				void submit();
			},
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === "Escape") close();
			},
		},
		h(
			"div",
			{ class: "mailbox-write-head" },
			h("h2", { id: "mailbox-write-title" }, t("New email")),
			h(
				"button",
				{ type: "button", class: "mailbox-icon", "aria-label": t("Close"), onclick: close },
				icon("close"),
			),
		),
		h(
			"div",
			{ class: "mailbox-write-row", role: "radiogroup", "aria-label": t("Who writes it") },
			h("span", { class: "mailbox-write-label" }, t("Writer")),
			...writers.map((writer) =>
				h(
					"button",
					{
						type: "button",
						role: "radio",
						class: `mailbox-pick${writer === chosen ? " is-current" : ""}`,
						"aria-checked": String(writer === chosen),
						onclick: () => {
							ui.writer = writer.id;
							page.redraw();
						},
					},
					figure(page, writer.id, undefined, 30),
					agentName(page, writer.id),
				),
			),
			from
				? h("span", { class: "mailbox-muted mailbox-from-address" }, t("from {address}", { address: from }))
				: null,
		),
		h(
			"label",
			{ class: "mailbox-write-row" },
			h("span", { class: "mailbox-write-label" }, t("To")),
			h("input", {
				placeholder: t("Name or email address"),
				value: ui.writeTo,
				autocomplete: "off",
				"data-focus-key": "write-to",
				oninput: (event: Event) => {
					ui.writeTo = (event.target as HTMLInputElement).value;
				},
			}),
		),
		h(
			"label",
			{ class: "mailbox-write-text" },
			h("span", { class: "visually-hidden" }, t("What should it say")),
			h(
				"textarea",
				{
					rows: "7",
					placeholder: t("What should it say?"),
					"data-focus-key": "write-text",
					oninput: (event: Event) => {
						ui.writeText = (event.target as HTMLTextAreaElement).value;
					},
				},
				ui.writeText,
			),
		),
		h(
			"div",
			{ class: "mailbox-write-foot" },
			h(
				"button",
				{ type: "submit", class: "mailbox-primary", disabled: ui.busy || !chosen },
				chosen ? t("Ask {name} to write it", { name: agentName(page, chosen.id) }) : t("Write"),
			),
			chosen
				? h(
						"span",
						{ class: "mailbox-muted" },
						t("{name} writes and sends it", { name: agentName(page, chosen.id) }),
					)
				: null,
		),
	);
}
