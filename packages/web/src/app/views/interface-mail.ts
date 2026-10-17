/* The Mailbox's own drawing (Interfaces step I5c; RUNTIME-INTERFACES.md §3.2 `mail`, §4): a `mail` block's thread,
 * drawn with the email card the conversations use, and what a `mail` list adds to a list block (its unread mark, its
 * "Show older", and how it says it is still being read).
 *
 * Mail is drawn as plain text and nothing else: every value is set as text, so a body that holds HTML shows its tags,
 * and nothing remote is ever fetched (no images, no links). What came from outside the company carries a quiet mark
 * (`outside`): a received message's sender, recipients, subject, attachments' names and text, and a thread's subject
 * and sender in a list. Account mail (A1) shows only that it is account mail, for which account, and who last used the
 * account and when, never its text. A send an agent wants to make that waits for a person is drawn as that card is in
 * its conversation, with its answer where this member may give it. */

import type { TableRow } from "@qorpera/cloud-client/interfaces";
import type { MailAccount, MailMessage, MailThread, MailWaitingSend } from "../../cloud/mail.ts";
import { fmtTime, h, notice, spinner } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { CompanyMail, type MailList, type MailListRequest, mailListKey } from "../company-mail.ts";
import { mailSummary, rowThread } from "../interface-mail.ts";

/** Marks an element as holding words from outside the company (§4): a quiet tint, and a title that says so. */
export function outside<T extends HTMLElement>(element: T): T {
	element.classList.add("interface-outside");
	element.title = t("From outside the company");
	return element;
}

/** The mark of a thread with mail the member hasn't read. */
export function unreadMark(): HTMLElement {
	return h("span", { class: "interface-unread" }, h("span", { class: "visually-hidden" }, t("Unread")));
}

/** A list line's words, and whether they came from outside. */
export interface ListText {
	readonly text: string;
	readonly outside: boolean;
}

/** A mail row's line and sub where its template fills in nothing: the sender's address, and for account mail
 * that it is account mail (its subject is never read). */
export function mailListText(
	company: CompanyController,
	row: TableRow,
	line: ListText,
	sub: ListText,
): { readonly line: ListText; readonly sub: ListText } {
	const thread = rowThread(row);
	const account = thread === undefined ? undefined : mailSummary(company, thread)?.account;
	const sender = typeof row.from_address === "string" && row.from_address ? row.from_address : null;
	return {
		line: line.text
			? line
			: sender !== null
				? { text: sender, outside: true }
				: { text: t("Unknown sender"), outside: false },
		sub: !sub.text && account ? { text: t("Account mail"), outside: false } : sub,
	};
}

/** What follows a `mail` list: that it is being read, why it couldn't be, or "Show older" while older threads are
 * there. */
export function mailListFooter(
	company: CompanyController,
	request: MailListRequest,
	list: MailList | undefined,
	blockKey: string,
): HTMLElement | null {
	const mail = CompanyMail.of(company);
	const key = mailListKey(request);
	if (!list) return spinner(t("Reading the mail"));
	if (list.status === "error")
		return notice(
			"danger",
			h("p", null, list.error ?? t("The mail can't be read right now.")),
			h(
				"button",
				{
					type: "button",
					class: "interface-button",
					"data-focus-key": `retry:${blockKey}`,
					onclick: () => mail?.retry(key),
				},
				t("Try again"),
			),
		);
	if (!list.next) return null;
	const loading = list.older === "loading";
	return h(
		"div",
		{ class: "interface-mail-older" },
		list.older === "error"
			? h("p", { class: "interface-note", role: "alert" }, t("Older mail can't be read."))
			: null,
		h(
			"button",
			{
				type: "button",
				class: "interface-button",
				"data-focus-key": `older:${blockKey}`,
				disabled: loading,
				"aria-busy": loading ? "true" : null,
				onclick: () => mail?.older(key),
			},
			loading ? t("Reading older mail") : list.older === "error" ? t("Try again") : t("Show older"),
		),
	);
}

/** How the agents a thread names are named here. */
export type AgentName = (agentId: string, given?: string) => string;

/** A `mail` block's open thread: its subject, the block's buttons, its messages oldest first, and the sends that
 * wait for a person. `answerable` is whether the block offers `answer` (§3.3). */
export function mailThreadParts(options: {
	readonly company: CompanyController;
	readonly row: TableRow;
	readonly lineId: string;
	readonly blockKey: string;
	readonly actions: HTMLElement | null;
	readonly answerable: boolean;
	readonly canWrite: boolean;
	readonly agentName: AgentName;
}): (HTMLElement | null)[] {
	const { company, row, lineId, blockKey, actions, agentName } = options;
	const thread = rowThread(row);
	const mail = company.store.get().mail;
	const read = thread === undefined ? undefined : mail?.threads[thread];
	const summary = thread === undefined ? undefined : mailSummary(company, thread);
	const subject = typeof row.subject === "string" && row.subject ? row.subject : null;
	const title = summary?.account
		? h("h2", { id: lineId, class: "interface-mail-subject" }, t("Account mail"))
		: subject !== null
			? outside(h("h2", { id: lineId, class: "interface-mail-subject" }, subject))
			: h("h2", { id: lineId, class: "interface-mail-subject" }, t("(no subject)"));
	const handler = typeof row.handled_by === "string" ? agentName(row.handled_by, summary?.handledBy?.name) : null;
	const head = h(
		"header",
		{ class: "interface-mail-head" },
		title,
		h(
			"p",
			{ class: "interface-mail-meta" },
			[
				typeof row.address === "string" ? row.address : null,
				handler ? t("Handled by {name}", { name: handler }) : null,
			]
				.filter((part): part is string => part !== null)
				.join(" · "),
		),
		actions,
	);
	if (thread === undefined || read === undefined) return [head, spinner(t("Reading the email"))];
	if (read.status === "gone")
		return [head, h("p", { class: "interface-empty" }, t("This email thread is no longer here."))];
	if (read.status === "error")
		return [
			head,
			notice(
				"danger",
				h("p", null, read.error),
				h(
					"button",
					{
						type: "button",
						class: "interface-button",
						"data-focus-key": `retry:${blockKey}:${thread}`,
						onclick: () => CompanyMail.of(company)?.retryThread(thread),
					},
					t("Try again"),
				),
			),
		];
	const shown = read.thread;
	const loading = read.older === "loading";
	return [
		head,
		shown.nextBefore
			? h(
					"div",
					{ class: "interface-mail-older interface-mail-more" },
					read.older === "error"
						? h("p", { class: "interface-note", role: "alert" }, t("Older messages can't be read."))
						: null,
					h(
						"button",
						{
							type: "button",
							class: "interface-button",
							"data-focus-key": `older-messages:${blockKey}:${thread}`,
							disabled: loading,
							"aria-busy": loading ? "true" : null,
							onclick: () => CompanyMail.of(company)?.olderMessages(thread),
						},
						loading
							? t("Reading older messages")
							: read.older === "error"
								? t("Try again")
								: t("Show older messages"),
					),
				)
			: null,
		h(
			"ol",
			{ class: "interface-mail-messages" },
			...shown.messages.map((message) => h("li", null, messageCard(message, agentName))),
		),
		...waitingCards(company, thread, shown, options),
	];
}

function field(label: string, value: string, fromOutside: boolean): HTMLElement {
	const shown = h("span", { class: "email-draft-from" }, value);
	return h(
		"div",
		{ class: "email-draft-row" },
		h("span", { class: "email-draft-label" }, label),
		fromOutside ? outside(shown) : shown,
	);
}

function accountLine(account: MailAccount, agentName: AgentName): string {
	if (account.unknown) return t("Account mail (unknown account)");
	const parts = [t("Account mail")];
	if (account.site) parts.push(account.site);
	const when = account.lastUsedAt ? fmtTime(account.lastUsedAt) : "";
	if (account.lastUsedBy)
		parts.push(
			when
				? t("last used by {agent} {time}", { agent: agentName(account.lastUsedBy), time: when })
				: t("last used by {agent}", { agent: agentName(account.lastUsedBy) }),
		);
	else if (when) parts.push(t("last used {time}", { time: when }));
	return parts.join(" · ");
}

function sentStatus(status: string): string {
	if (status === "queued") return t("Queued");
	if (status === "sent") return t("Sent");
	if (status === "failed") return t("Not sent");
	return status;
}

/** One message as the email card, read-only. */
function messageCard(message: MailMessage, agentName: AgentName): HTMLElement {
	const received = message.kind === "received";
	const time = h("time", { class: "email-draft-status", datetime: message.at }, fmtTime(message.at));
	if (received && message.account)
		return h(
			"article",
			{ class: "interaction-card email-draft-card review-email interface-mail-message is-account" },
			h("header", { class: "email-draft-heading" }, h("h3", null, accountLine(message.account, agentName)), time),
		);
	const sender = [
		message.fromName,
		message.fromAddress && message.fromName ? `<${message.fromAddress}>` : message.fromAddress,
	]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ");
	const by =
		!received && message.staffAgent ? agentName(message.staffAgent.staffAgentId, message.staffAgent.name) : null;
	const heading = h("h3", null, sender || by || t("Unknown sender"));
	const notes = [
		received && message.automated ? t("Automated email") : null,
		received && message.textTruncated ? t("This email is longer; only its start is shown.") : null,
		message.textCleared ? t("This email's text is no longer kept.") : null,
	].filter((note): note is string => note !== null);
	const body = message.text ? h("div", { class: "review-email-body" }, message.text) : null;
	const names = message.attachments.map((attachment) => attachment.filename).join(", ");
	return h(
		"article",
		{ class: `interaction-card email-draft-card review-email interface-mail-message is-${message.kind}` },
		h(
			"header",
			{ class: "email-draft-heading" },
			received && sender ? outside(heading) : heading,
			h(
				"span",
				{ class: "interface-mail-when" },
				by && sender ? h("span", { class: "email-draft-status" }, by) : null,
				received ? null : h("span", { class: "email-draft-status" }, sentStatus(message.status)),
				time,
			),
		),
		h(
			"div",
			{ class: "email-draft-panel" },
			message.to.length ? field(t("To"), message.to.join(", "), received) : null,
			message.cc.length ? field(t("Cc"), message.cc.join(", "), received) : null,
			message.subject ? field(t("Subject"), message.subject, received) : null,
			body && received ? outside(body) : body,
			names ? field(t("Attachments"), names, received) : null,
		),
		notes.length ? h("p", { class: "interface-note interface-mail-notes" }, notes.join(" ")) : null,
	);
}

/** An agent's own thread, where its sends can be answered too; none for an agent no longer at work. */
function agentThread(company: CompanyController, agentId: string): string | null {
	if (company.staffById(agentId)?.employmentStatus !== "active") return null;
	const profileId = company.profile.profileId;
	return agentId === company.cofounderId() ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
}

/** The sends in a thread that wait for a person, as their review card: what the agent wants to send, and the answer
 * where this member may give it (a `sessionId`, write access, and a block that offers `answer`). An answer refused
 * for want of the member's model account points to the agent's thread, where they choose one. */
function waitingCards(
	company: CompanyController,
	thread: string,
	read: MailThread,
	options: { readonly answerable: boolean; readonly canWrite: boolean; readonly agentName: AgentName },
): HTMLElement[] {
	const answers = company.store.get().mail?.answers ?? {};
	return read.waiting.map((send: MailWaitingSend) => {
		const given = answers[send.reviewId];
		const agent = send.staffAgent ? options.agentName(send.staffAgent.staffAgentId, send.staffAgent.name) : null;
		const there =
			given?.needsAccount && send.staffAgent && agent ? agentThread(company, send.staffAgent.staffAgentId) : null;
		const sessionId = send.sessionId;
		const mayAnswer = sessionId !== undefined && options.canWrite && options.answerable && !given?.answered;
		const answer = (choice: "allow_once" | "deny") => () => {
			if (sessionId) void CompanyMail.of(company)?.answer(thread, sessionId, send.reviewId, choice);
		};
		const pending = given?.pending === true;
		const names = send.attachments.map((attachment) => attachment.filename).join(", ");
		return h(
			"article",
			{
				class: "interaction-card email-draft-card action-review-card review-email interface-mail-waiting",
				"data-review-id": send.reviewId,
			},
			h(
				"header",
				{ class: "email-draft-heading" },
				h("h3", null, agent ? t("{name} wants to send this email", { name: agent }) : t("New email")),
				h(
					"span",
					{ class: "email-draft-status" },
					given?.answered ? t("Answered") : mayAnswer ? t("Waiting for you") : fmtTime(send.createdAt),
				),
			),
			h(
				"div",
				{ class: "email-draft-panel" },
				send.to.length ? field(t("To"), send.to.join(", "), false) : null,
				send.cc.length ? field(t("Cc"), send.cc.join(", "), false) : null,
				send.subject ? field(t("Subject"), send.subject, false) : null,
				send.text ? h("div", { class: "review-email-body" }, send.text) : null,
				names ? field(t("Attachments"), names, false) : null,
			),
			given?.error
				? h(
						"p",
						{ class: "email-draft-error", role: "alert" },
						there && agent
							? t(
									"This answer needs your model account. Answer it in {name}'s thread, where you can choose one.",
									{
										name: agent,
									},
								)
							: given.error,
					)
				: null,
			there && agent
				? h(
						"a",
						{
							class: "interface-button interface-mail-thread",
							href: there,
							"data-focus-key": `thread:${send.reviewId}`,
						},
						t("Open {name}'s thread", { name: agent }),
					)
				: null,
			mayAnswer
				? h(
						"div",
						{ class: "review-answer" },
						h(
							"div",
							{ class: "email-draft-actions" },
							h(
								"button",
								{
									type: "button",
									class: "btn email-draft-send",
									disabled: pending,
									"data-focus-key": `send:${send.reviewId}`,
									onclick: answer("allow_once"),
								},
								t("Send email"),
							),
							h(
								"button",
								{
									type: "button",
									class: "btn",
									disabled: pending,
									"data-focus-key": `deny:${send.reviewId}`,
									onclick: answer("deny"),
								},
								t("Don't send"),
							),
						),
					)
				: given?.answered
					? null
					: h("p", { class: "review-waiting" }, t("This send waits for someone who can answer it.")),
		);
	});
}
