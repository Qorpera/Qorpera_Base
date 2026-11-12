import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { describeError } from "../../cloud/client.ts";
import { WebCompanyFolderRejectedError, withProblems } from "../../cloud/company-folder-writes.ts";
import type { DigitalPostLetter } from "../../cloud/digital-post.ts";
import type { EventHook } from "../../cloud/event-hooks.ts";
import type {
	MailAccount,
	MailAddress,
	MailAgent,
	MailMember,
	MailMessage,
	MailMessageRef,
	MailThreadSummary,
	MailWaitingItem,
	MailWaitingSend,
} from "../../cloud/mail.ts";
import {
	canPayForRoutine,
	claudeLogin,
	latestVersions,
	type WebRoutine,
	type WebRoutines,
} from "../../cloud/routines.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { type MenuEntry, openContextMenu } from "../../ui/context-menu.ts";
import { fmtTime, h, icon, notice, personAvatar, spinner } from "../../ui/dom.ts";
import { presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
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
import { type DigitalPostClient, DigitalPostView } from "./settings-digital-post.ts";
import { type HooksClient, HooksView } from "./settings-hooks.ts";

/* The Mailbox page, drawn as a mail app (Jonas, 10 Nov 2026: "more like just using Gmail inside of qorpera"): Write
 * and the folders Inbox, Sent and Addresses at the side, a search field across the top, and one dense line per thread.
 * The side is a drawer with words on a wide page, a rail of icons on a narrower one and a row under the search on a
 * phone; styles/mailbox.css picks by the Mailbox's own width, since the app's rail takes a share of the window. The
 * page's definition (the cloud client's library) still names it, gives it its rail row and badge and decides who sees
 * it; this view draws it from the company's mail as app/company-mail.ts reads it, not from the definition's blocks.
 *
 * - Inbox: the sends that wait for a person first ("Waiting for you", with Send and Don't send on the line), then every
 *   other thread, newest first. A line shows who wrote, the subject, the start of the newest message (`snippet`), the
 *   agent who handles it (grey while the thread is new) and when. Search narrows the lines read so far.
 * - A thread: its messages oldest first, each folded to one line but the newest, the sends waiting in it, and under
 *   them Reply, Reply all and Forward, as a mail app has them (Jonas, 12 Nov 2026: "similar answer/reply buttons as in
 *   the real gmail/outlook app, not the chatcomposer to tell other agents what to reply"). One of them opens the answer
 *   at the thread's foot: who it goes to as chips, its text and Send, which sends it as the member's own email in that
 *   thread (cloud/mail.ts `replyTo`). A forward is a new email, the message's text under the member's own words. The
 *   answer's Writer chip gives it to an agent instead, as the Write window's does: the member's words then go to that
 *   agent as their own message, with the email's subject and sender as quotes (contract, "quoted outside content in a
 *   member's message"), and the agent's review decides as for any send.
 * - Sent: the threads whose newest message the company sent. Addresses: each address on one line, with who answers it
 *   and how much came in the last 7 days. An owner or admin gives an address to an agent there, in one step (Jonas,
 *   12 Nov 2026: "don't like the UX of giving an agent an email - should be more intuitive"): the chip on the address's
 *   line opens the agents, those who answer it ticked, and a press gives the address to an agent or takes it from one.
 *   Behind it that is a routine of the agent's that starts on mail to the address, written as the member's own save,
 *   on their own model account that works while they are away. An address may have several agents, as the cloud lets
 *   several routines listen to a mailbox: one agent's answering is one thing, and nobody else's changes with it
 *   (`giveAddress`). The form that adds an address asks who answers it too.
 * - Write: the member writes an email. Nobody owns a new one: the Writer chip says "You" (Jonas, 10 Nov 2026: "It
 *   should have no agent owning it by default"), and Send sends it as the member's own email from one of the company's
 *   addresses (contract, M2e). Who it goes to are chips, as a mail app has them: an address typed becomes one at a
 *   space, a comma or Enter, and one that is no email address is marked and holds the send. With an agent picked from
 *   the Writer chip's menu, that agent writes and sends it instead, and its review decides as for any send. A member's
 *   own email shows in Sent and in its thread with the member's picture.
 *
 * - Digital Post (deploy/first-node/RUNTIME-DIGITAL-POST.md): the letters the company folder holds from public
 *   authorities are lines of the Inbox among the threads, newest first, each with the authority as its sender and a
 *   Digital Post mark. A letter opens to its text and its documents (which open in Storage), with a line to ask an agent
 *   about it. Addresses has a Digital Post row, and its Choose asks the Co-Founder to give it an agent. The Mailbox shows
 *   while the company has an email address, or Digital Post connected or holding letters.
 * - Making addresses (Jonas, 9 Nov 2026: they live here, not in Settings): under Addresses, and on the page with no
 *   address yet, an owner or admin adds, pauses or removes the company's mail addresses and connects Digital Post.
 *   The addresses are the company's mailboxes as Settings' card lists them (views/settings-hooks.ts), each line with
 *   this page's own part: who answers it. Every member sees them; only an owner or admin changes them.
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
	/** The Write window's new email. */
	write: Draft;
	/** The answers being written, by thread: one a thread, kept while the member reads elsewhere. */
	replies: Record<string, Reply>;
	/** What is typed in the line to an agent about a Digital Post letter. */
	note: string;
	/** `digital-post` while its row asks who reads it. */
	changing: string | null;
	/** The address being given to an agent (`on`) or taken from one, while that is on its way: its chip waits. */
	answering: { readonly address: string; readonly agent: string; readonly on: boolean } | null;
	/** Why an address could not be given to the agent picked, by address. */
	answerErrors: Record<string, string>;
	/** Who answers the address the Add form makes; nobody until the member picks. */
	addAgent: string | null;
	busy: boolean;
	error: string | null;
	toast: { readonly text: string; readonly agent: string | null; readonly id: number } | null;
}

/** Who an email being written goes to, on one of its lines. */
interface Recipients {
	/** One chip each, as it was read when it was typed. A chip is never read again: it stays what it is whoever writes
	 * the email. With an agent as the writer it may be a name; in the member's own email one that is no address is
	 * marked. */
	chips: string[];
	/** What is typed after them and is not yet a chip. */
	typed: string;
}

/** An email being written: the Write window's new email, or an answer in a thread. */
interface Draft {
	/** The agent who writes it; nobody's while the member writes it themself. */
	writer: string | null;
	to: Recipients;
	cc: Recipients;
	subject: string;
	text: string;
	/** The company address the member's own email goes from; the first one in use until they pick another. */
	from: string | null;
	/** The member's send being tried, and the email it was: sent again as it stands it is one email (contract, M2e);
	 * changed in any part, it is a new one. */
	send: { readonly id: string; readonly email: string } | null;
	/** Why the member's email did not go, said in the window it is written in. */
	error: string | null;
}

/** An answer being written in a thread: to who sent the message, to everyone it went to as well, or the message sent
 * on to someone else. */
interface Reply extends Draft {
	readonly kind: "reply" | "all" | "forward";
	/** The message it answers, as the thread names it. A forward answers none: it is a new email. */
	readonly message: MailMessageRef;
}

const newDraft = (): Draft => ({
	writer: null,
	to: { chips: [], typed: "" },
	cc: { chips: [], typed: "" },
	subject: "",
	text: "",
	from: null,
	send: null,
	error: null,
});

const uis = new WeakMap<HTMLElement, MailboxUi>();
/** A number for each company controller drawn: the company opened again draws afresh, so the cards it keeps are its. */
const controllers = new WeakMap<CompanyController, number>();
let controllerCount = 0;
function controllerKey(company: CompanyController): number {
	let key = controllers.get(company);
	if (key === undefined) {
		key = ++controllerCount;
		controllers.set(company, key);
	}
	return key;
}
/** The address and Digital Post cards of a page's state, kept so a form being filled survives a redraw: for the company
 * controller, the language and the time zone they were built for. The cards' own parts are drawn for the page as it
 * was last drawn (`page`). Digital Post's card is an owner's or admin's, made once the member is one. */
interface ManageViews {
	readonly company: CompanyController;
	readonly locale: string;
	readonly zone: string;
	readonly calls: MailboxManage;
	readonly hooks: HooksView;
	post: DigitalPostView | undefined;
	page: Page;
	/** What the cards' own parts were last drawn from: they are drawn again only when it changed. */
	shown: string;
}
const manageViews = new WeakMap<MailboxUi, ManageViews>();
/** A page's addresses being given to agents, one after another: the last of them. */
const answerings = new WeakMap<MailboxUi, Promise<void>>();
/** Who answers an address as the routines said when it was last given or taken on a page, by address, where the
 * addresses could not be read after it: the agents, and the addresses as they were read last (`read`). The line goes
 * by the agents while the addresses are still those, and by the addresses' own word once they are read again. */
const answeredBy = new WeakMap<
	MailboxUi,
	Map<string, { readonly agents: readonly string[]; readonly read: readonly MailAddress[] | undefined }>
>();

/** The agents who answer an address: as the mail's addresses say, or as the routines said when it was given or taken
 * here and the addresses could not be read since (`answeredBy`), so its line never goes back to what was. */
function handlersOf(page: Page, address: string): readonly MailAgent[] {
	const read = page.company.store.get().mail?.addresses;
	const listed = read?.find((item) => item.address === address)?.handledBy ?? [];
	const kept = answeredBy.get(page.ui)?.get(address);
	if (!kept || kept.read !== read) return listed;
	return kept.agents.map(
		(staffAgentId) => listed.find((each) => each.staffAgentId === staffAgentId) ?? { staffAgentId },
	);
}
/** The chip of a page whose menu is open (the Write window's `writer` or `from`, an answer's `reply-writer`): a redraw
 * under the menu draws it open. */
const chipMenus = new WeakMap<MailboxUi, string>();
/** The press outside a chip's menu that shut it: on that chip, the click that press ends in opens nothing. */
const chipPresses = new WeakMap<MailboxUi, { readonly chip: string; readonly press: Event }>();
let toastIds = 0;

/** An email address as the cloud takes one (`qorpera_send_member_mail`), in lower case. */
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** How many addresses one email goes to, at most (the same call). */
const MOST_RECIPIENTS = 10;
const isAddress = (text: string) => text.length <= 254 && ADDRESS.test(text.toLowerCase());
/** One entry of a list of who an email goes to, read by its marks. */
interface Entry {
	/** The address it points at ("Anna Holm <anna@acme.dk>"), or null when it points at nothing. It alone is the entry's
	 * recipient, whatever stands beside it: the name may be an address of its own ("old@acme.dk <anna@acme.dk>"), and
	 * nobody at it is written to. An entry that points at what is no address ("Carl <carl@gmaill>", "Anna <Acme>"), at
	 * more than one address, or has one more standing after the one it points at, says no clear thing: it is kept here
	 * whole, as it stands, which is no address, for the member to put right. Whole, so that two such entries are never
	 * made one ("Anna <Acme>", "Bo <Acme>"). */
	pointed: string | null;
	/** The rest, in the order it stands: what is plain, and each aside whole. An aside is a quoted text or a remark in
	 * round brackets: a name or a note, and never a recipient, whatever it holds and wherever it stands, alone in its
	 * entry too ('"old@acme.dk"'). */
	parts: { text: string; aside: boolean }[];
	/** Where the list goes on after it. */
	end: number;
}
const POINTED = /<([^<>,;\n]*)>/y;
const PLAIN = /[^,;\n"(<]+/y;
/** A list of who an email goes to, as its entries. A comma, a semicolon or a line end closes an entry, but not one that
 * stands in an aside: a quoted name keeps its own ('"Holm, Anna" <anna@acme.dk>'), and so does a remark ("(formerly,
 * old@acme.dk)"). Nor is anything in an aside pointed at ('"Former <old@acme.dk>" <anna@acme.dk>' points at anna alone).
 * An aside runs to the mark that closes it, a remark over the remarks it holds. Left open it runs to the end of its
 * line, so what follows an open quote is never read as an entry of its own. */
function entriesOf(list: string): Entry[] {
	const entries: Entry[] = [];
	let pointed: string[] = [];
	let parts: Entry["parts"] = [];
	let unclear = false;
	let from = 0;
	const close = (stop: number, end: number) => {
		const [first] = pointed;
		const clear = first !== undefined && pointed.length === 1 && !unclear && isAddress(first);
		entries.push({
			pointed: clear ? first : first === undefined ? null : list.slice(from, stop).trim().replace(/\s+/g, " "),
			parts,
			end,
		});
		pointed = [];
		parts = [];
		unclear = false;
		from = end;
	};
	let at = 0;
	while (at < list.length) {
		const mark = list[at];
		let stop = at + 1;
		if (mark === "," || mark === ";" || mark === "\n") close(at, stop);
		else if (mark === '"' || mark === "(") {
			let open = 1;
			while (open && stop < list.length && list[stop] !== "\n") {
				const inside = list[stop];
				// A backslash takes the mark after it as it stands.
				stop += inside === "\\" && stop + 1 < list.length && list[stop + 1] !== "\n" ? 2 : 1;
				if (inside === (mark === "(" ? ")" : '"')) open -= 1;
				else if (inside === "(" && mark === "(") open += 1;
			}
			parts.push({ text: list.slice(at, stop), aside: true });
		} else {
			POINTED.lastIndex = at;
			PLAIN.lastIndex = at;
			const point = mark === "<" ? POINTED.exec(list) : null;
			if (point) stop = at + point[0].length;
			else if (PLAIN.test(list)) stop = PLAIN.lastIndex;
			const address = point?.[1]?.trim().replace(/^mailto:/i, "");
			const plain = list.slice(at, stop);
			const last = parts.at(-1);
			if (address) pointed.push(address);
			// What is plain stays one text, so a pointed bracket that closes nothing stays in its word ("<anna@acme.dk").
			else if (last && !last.aside) last.text += plain;
			else parts.push({ text: plain, aside: false });
			// The name stands before its address. An address after it is nobody's name: one more recipient, or none.
			if (!address && pointed.length && plain.includes("@")) unclear = true;
		}
		at = stop;
	}
	close(list.length, list.length);
	return entries;
}
/** What is typed for who an email goes to, as its recipients. An entry that points at its address is that address
 * alone. In one that points at nothing each address is a recipient, and what stands between is kept as the name it was
 * typed as ("Nordlys Energi"), an aside whole: no address, so a chip that says so. */
function asRecipients(text: string): string[] {
	const found: string[] = [];
	for (const entry of entriesOf(text)) {
		if (entry.pointed !== null) {
			found.push(entry.pointed);
			continue;
		}
		// An aside is one word, and its first mark keeps it from being an address.
		const words = entry.parts.flatMap((part) =>
			part.aside ? [part.text.trim()] : part.text.split(/\s+/).filter(Boolean),
		);
		let name: string[] = [];
		for (const word of [...words, null]) {
			if (word && !isAddress(word)) {
				name.push(word);
				continue;
			}
			if (name.length) found.push(name.join(" "));
			name = [];
			if (word) found.push(word);
		}
	}
	return found;
}
/** A list pasted into the member's own email, as its recipients. Only an address can be sent to there, so the name
 * beside one is left out. An entry that points at its address is that address alone. One that points at nothing and
 * has an address outside an aside is that address ("mailto:bo@acme.dk", "Bo Berg bo@acme.dk"): the name and the asides
 * beside it are left out, and whatever else has an `@` there is kept with it, right or wrong. An entry with no address
 * in it has nothing to stand for it: it is kept whole, as it stands, with what tells it from another ("Anna (Acme)",
 * "Anna (Beta)"). So no entry is dropped, and no two are made one: what is no address becomes a chip that says so. */
function pastedRecipients(text: string): string[] {
	const found: string[] = [];
	for (const entry of entriesOf(text)) {
		if (entry.pointed !== null) {
			found.push(entry.pointed);
			continue;
		}
		const addressed = entry.parts
			.filter((part) => !part.aside)
			.flatMap((part) => part.text.split(/[\s<>)[\]]+/))
			.map((word) => word.replace(/^mailto:/i, ""))
			.filter((word) => word.includes("@"));
		const whole = entry.parts
			.map((part) => part.text)
			.join("")
			.trim()
			.replace(/\s+/g, " ");
		if (addressed.some(isAddress)) found.push(...addressed);
		else if (whole) found.push(whole);
	}
	return found;
}

/** The calls behind the company's mail addresses and its Digital Post key. */
export interface MailboxManage {
	readonly hooks: HooksClient;
	readonly digitalPost: DigitalPostClient;
	/** The routines behind "who answers an address": an agent answers one through a routine that starts on its mail.
	 * Without them, and the member's accounts, who answers an address is only shown. */
	readonly routines?: Pick<WebRoutines, "list" | "save" | "setEnabled">;
	/** The signed-in member's own model accounts: such a routine runs on one of them. */
	readonly accounts?: (signal: AbortSignal) => Promise<NativeExecutionConnections>;
}

export interface MailboxOptions {
	/** Where the company's addresses are made and Digital Post is connected, by an owner or admin. */
	readonly manage?: () => MailboxManage;
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
			write: newDraft(),
			replies: {},
			note: "",
			changing: null,
			answering: null,
			answerErrors: {},
			addAgent: null,
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
		controllerKey(company),
		company.userId,
		presentationLocale(),
		presentationTimeZone(),
		new Date().toDateString(),
		name,
		{ ...ui, toast: ui.toast?.id ?? null },
		// The addresses whose lines still go by what the routines said (`answeredBy`): a new read of the addresses
		// draws them from it, also when it reads the same as the last one.
		[...(answeredBy.get(ui) ?? [])].map(([address, kept]) => [address, kept.agents, kept.read === mail?.addresses]),
		state.team?.capabilities.write === true,
		state.team?.capabilities.authorize === true,
		state.team?.members.map((member) => [member.userId, member.displayName]) ?? null,
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
	show(container, key, () => settle(container.firstElementChild, drawPage(page)), moveFocus);
	CompanyMail.of(company)?.watch(lists, threads, stillShown, letters);
}

/** Marks what `drawn` shows that `before` showed too, so only what is new on screen moves in: a letter typed in the
 * search field, or an answer on its way, redraws the page without setting every line in motion again. */
function settle(before: Element | null, drawn: HTMLElement): HTMLElement {
	if (!before?.matches(".mailbox")) return drawn;
	const body = (root: Element) => {
		const scroll = root.querySelector<HTMLElement>(".mailbox-scroll");
		return `${scroll?.dataset.scrollKey} ${scroll?.firstElementChild?.className}`;
	};
	if (body(before) === body(drawn)) drawn.classList.add("is-settled");
	for (const window of [".mailbox-write-panel", ".mailbox-reply"])
		if (before.querySelector(window)) drawn.querySelector(window)?.classList.add("is-settled");
	const toast = drawn.querySelector(".mailbox-toast");
	if (toast && before.querySelector(".mailbox-toast")?.textContent === toast.textContent)
		toast.classList.add("is-settled");
	return drawn;
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

/** The agents at work, the Co-Founder first and the rest by name. */
function agentsAtWork(page: Page): HostedStaffAgent[] {
	const cofounder = page.company.cofounderId();
	return page.company.store
		.get()
		.staff.filter((agent) => agent.employmentStatus === "active")
		.sort((a, b) => (a.id === cofounder ? -1 : b.id === cofounder ? 1 : a.displayName.localeCompare(b.displayName)));
}

function figure(page: Page, agentId: string | undefined, given: string | undefined, size: number): HTMLElement {
	return agentFigure(page.company.staffById(agentId), given ?? "", { size });
}

/** A member's name as the company knows it now, else as the mail named them. */
function memberName(page: Page, member: MailMember): string {
	const known = page.company.store.get().team?.members.find((each) => each.userId === member.userId)?.displayName;
	return known || member.name || t("A member");
}

/** Who sent a member's own email, as a line says it: "You" to the one who did. */
function memberLabel(page: Page, member: MailMember): string {
	return member.userId === page.company.userId ? t("You") : memberName(page, member);
}

/** The picture of the member who sent an email themself, where an agent's figure stands for an agent's. */
function memberFace(page: Page, member: MailMember): HTMLElement {
	return personAvatar(memberName(page, member), member.userId);
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

/** Says what just happened at the foot of the page; `moveFocus` names the control that then has the focus. */
function say(page: Page, text: string, agent: string | null, moveFocus?: string): void {
	const id = ++toastIds;
	page.ui.toast = { text, agent, id };
	page.redraw(moveFocus);
	setTimeout(() => {
		if (page.ui.toast?.id !== id) return;
		page.ui.toast = null;
		page.redraw();
	}, TOAST_MS);
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
	const reading = mail !== undefined && !off && (ui.letter !== null || ui.open !== null);
	const writing = ui.writing && canWrite(page) && mail !== undefined && !off;
	return h(
		"section",
		{
			class: `mailbox${reading ? " is-reading" : ""}${writing ? " is-writing" : ""}`,
			"data-interface": page.name,
			"data-profile": page.profileId,
		},
		h(
			"div",
			{ class: "mailbox-frame" },
			off ? null : side(page),
			h(
				"div",
				{ class: "mailbox-main" },
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
			),
		),
		writing ? writePanel(page) : null,
		ui.toast ? toast(page, ui.toast.text, ui.toast.agent) : null,
	);
}

/** Write and the folders, at the side as a mail app has them. */
function side(page: Page): HTMLElement {
	const { ui } = page;
	const waiting = waitingItems(page).length;
	const tabs: readonly [Tab, string, string][] = [
		["inbox", t("Inbox"), "inbox"],
		// The paper plane is drawn once, under the name the approval settings gave it.
		["sent", t("Sent"), "external_communication"],
		["addresses", t("Addresses"), "at"],
	];
	return h(
		"div",
		{ class: "mailbox-side" },
		canWrite(page) && (page.company.store.get().mail?.addresses.length ?? 0) > 0
			? h(
					"button",
					{
						type: "button",
						class: "mailbox-write",
						title: t("Write"),
						"data-focus-key": "write",
						onclick: () => {
							// A new email is nobody's; one being written keeps the writer it was given.
							const { to, subject, text } = ui.write;
							if (!to.typed && !to.chips.length && !subject && !text) ui.write.writer = null;
							ui.writing = true;
							page.redraw("write-to");
						},
					},
					icon("edit"),
					h("span", { class: "mailbox-write-word" }, t("Write")),
				)
			: null,
		h(
			"div",
			{ class: "mailbox-tabs", role: "tablist", "aria-label": t("Mailbox") },
			...tabs.map(([tab, label, glyph]) =>
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
					h("span", { class: "mailbox-tab-icon" }, icon(glyph)),
					h("span", { class: "mailbox-tab-label" }, label),
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
	);
}

/** The search field across the top; Addresses, which has nothing to search, shows its name there. */
function bar(page: Page): HTMLElement {
	const { ui } = page;
	return h(
		"header",
		{ class: "mailbox-bar" },
		ui.tab === "addresses" && !ui.open && !ui.letter
			? h("h1", { class: "mailbox-title" }, t("Addresses"))
			: h(
					"label",
					{ class: "mailbox-search" },
					icon("search"),
					h("span", { class: "visually-hidden" }, t("Search mail")),
					h("input", {
						type: "search",
						placeholder: t("Search mail"),
						value: ui.search,
						"data-focus-key": "search",
						oninput: (event: Event) => {
							const field = event.target as HTMLInputElement;
							ui.search = field.value;
							ui.open = null;
							ui.letter = null;
							// What the new words find is read from its top, not from where the old list was left.
							const list = field.closest(".mailbox")?.querySelector(".mailbox-scroll");
							if (list) list.scrollTop = 0;
							page.redraw();
						},
					}),
				),
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
	// The first address is an owner's or admin's to make.
	const views = page.company.store.get().team?.capabilities.authorize === true ? manageOf(page) : null;
	return h(
		"div",
		{ class: "mailbox-empty" },
		h("h1", null, t("The company has no email address yet")),
		h("p", null, t("Make one, and pick the agent who answers what comes in.")),
		h("p", null, t("Letters from public authorities come here too, once Digital Post is connected.")),
		views
			? h("div", { class: "mailbox-manage" }, views.hooks.el, views.post?.el ?? null)
			: h("p", { class: "mailbox-muted" }, t("An owner or admin makes the company's addresses.")),
	);
}

/** The company's mail addresses as lines, each with who answers it, which an owner or admin adds, pauses, removes and
 * gives to an agent, and Digital Post for them to connect. None where the page was given no calls for them. A change
 * reads the company's mail again, so a new address shows at once. */
function manageOf(page: Page): ManageViews | null {
	const { company, ui, options } = page;
	if (!options.manage) return null;
	let views = manageViews.get(ui);
	// The company opened again (a new controller, the old one stopped), a new language or a new time zone: the cards
	// are built again.
	if (
		views &&
		(views.company !== company ||
			company.signal.aborted ||
			views.locale !== presentationLocale() ||
			views.zone !== presentationTimeZone())
	) {
		views.hooks.dispose();
		views.post?.dispose();
		manageViews.delete(ui);
		views = undefined;
	}
	const access = { canManage: () => company.store.get().team?.capabilities.authorize === true };
	const changed = () => void CompanyMail.of(company)?.reread();
	if (!views) {
		const calls = options.manage();
		// The cards' own parts are drawn for the page as it stands when they are drawn.
		const drawn = () => manageViews.get(ui)?.page ?? page;
		views = {
			company,
			locale: presentationLocale(),
			zone: presentationTimeZone(),
			calls,
			page,
			shown: "",
			post: undefined,
			hooks: new HooksView(calls.hooks, company.signal, {
				access,
				kinds: ["mailbox"],
				changed,
				card: (hook) => answerer(drawn(), calls, hook),
				form: () => newAnswerer(drawn(), calls),
				// The new address goes to the agent its form named.
				added: (hook) => {
					const now = drawn();
					const agent = now.ui.addAgent;
					now.ui.addAgent = null;
					if (agent && hook.email)
						void answerWith(now, calls, { address: hook.email, hookId: hook.id }, agent, true);
				},
			}),
		};
		manageViews.set(ui, views);
	}
	views.page = page;
	if (access.canManage())
		views.post ??= new DigitalPostView(views.calls.digitalPost, company.signal, { access, changed });
	views.hooks.update();
	// Who answers an address is the mail's to say: its lines are drawn again when that, or what the member is doing
	// about it, changed. A form being filled is otherwise left alone.
	const state = company.store.get();
	const shown = JSON.stringify([
		state.mail?.addresses ?? null,
		(state.mail?.addresses ?? []).map((address) => handlersOf(page, address.address)),
		ui.answering,
		ui.answerErrors,
		ui.addAgent,
		assigns(page, views.calls),
		state.staff.map((agent) => [agent.id, agent.displayName, agent.employmentStatus, agent.appearance]),
	]);
	if (views.shown !== shown) {
		views.shown = shown;
		views.hooks.redraw();
	}
	views.post?.update();
	return views;
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

/** A click anywhere on a line opens it, as in a mail app; the button inside is what the keyboard reaches. */
function wholeLine(open: () => void): (event: MouseEvent) => void {
	return (event) => {
		if (!(event.target as Element).closest("button, a")) open();
	};
}

/** Between a subject and the start of the text. Its own element, so the phone layout can set the text on a line of
 * its own without it. */
const dash = () => h("span", { class: "mailbox-dash" }, " — ");

function threadLine(page: Page, summary: MailThreadSummary): HTMLElement {
	const sent = page.ui.tab === "sent";
	const agentId = summary.handledBy?.staffAgentId;
	const agent = agentName(page, agentId, summary.handledBy?.name);
	// A newest message that a member sent themself is theirs: their name and their picture, not an agent's.
	const member = summary.sentBy;
	const sender = member ? memberLabel(page, member) : agent;
	const isNew = summary.state === "new";
	const unread = summary.unread && !sent;
	const who = summary.account
		? h("span", { class: "mailbox-who" }, icon("lock"), h("span", null, t("Account mail")))
		: h(
				"span",
				{ class: "mailbox-who" },
				sent ? h("span", { class: "mailbox-to-label" }, t("To:")) : null,
				outside(partyText(summary)),
				summary.direction === "sent" && !sent && (member || summary.handledBy)
					? h("span", { class: "mailbox-by" }, `, ${sender}`)
					: null,
				summary.messages > 1 ? h("span", { class: "mailbox-n" }, String(summary.messages)) : null,
			);
	const line = summary.account
		? h(
				"span",
				{ class: "mailbox-line" },
				h("span", { class: "mailbox-subject" }, accountSite(summary.account)),
				h("span", { class: "mailbox-snippet" }, dash(), accountUse(page, summary.account)),
			)
		: h(
				"span",
				{ class: "mailbox-line" },
				isNew && !sent ? h("span", { class: "mailbox-state is-new" }, t("New")) : null,
				outside(summary.subject || t("(no subject)"), "span", "mailbox-subject"),
				summary.snippet
					? summary.direction === "sent"
						? h("span", { class: "mailbox-snippet" }, dash(), `${sender}: `, outside(summary.snippet))
						: h("span", { class: "mailbox-snippet" }, dash(), outside(summary.snippet))
					: null,
			);
	return h(
		"li",
		{
			class: `mailbox-row${unread ? " is-unread" : ""}`,
			onclick: wholeLine(() => openThread(page, summary.thread)),
		},
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
		member
			? h(
					"span",
					{
						class: "mailbox-handler",
						title:
							member.userId === page.company.userId
								? t("You sent it")
								: t("{name} sent it", { name: memberName(page, member) }),
					},
					memberFace(page, member),
				)
			: agentId
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
			item.snippet ? h("span", { class: "mailbox-snippet" }, dash(), `${agent}: ${item.snippet}`) : null,
		),
	];
	const thread = item.thread;
	return h(
		"li",
		{
			class: `mailbox-row is-waiting${answered ? " is-leaving" : ""}`,
			onclick: thread ? wholeLine(() => openThread(page, thread)) : null,
		},
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
	const parts: (HTMLElement | null)[] = [
		h(
			"div",
			{ class: "mailbox-toolbar" },
			back,
			handler
				? h(
						"span",
						{ class: "mailbox-handled" },
						figure(page, handler, summary?.handledBy?.name, 24),
						t("{name} handles it", { name: agentName(page, handler, summary?.handledBy?.name) }),
					)
				: null,
		),
		h(
			"header",
			{ class: "mailbox-thread-head" },
			title,
			summary ? h("span", { class: "mailbox-label" }, summary.address) : null,
		),
	];
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
			replyArea(page, thread, summary, last),
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
	// An email a member sent themself is theirs: no agent wrote it.
	const member = received ? undefined : message.member;
	const agentId = received ? undefined : message.staffAgent?.staffAgentId;
	const agent = received ? "" : agentName(page, agentId, message.staffAgent?.name);
	const sender = senderOf(message);
	const name = received
		? message.fromName || message.fromAddress || t("Unknown sender")
		: member
			? memberLabel(page, member)
			: agent || sender;
	const avatar = received
		? h("span", { class: "mailbox-initials", "aria-hidden": "true" }, initials(name) || "?")
		: member
			? memberFace(page, member)
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

/** Sends a note through the company's mail reader; a note that can't go from here waits in the agent's thread.
 * `focus` names the control that takes the keyboard after it, when the note went and when it did not: what asked is
 * drawn disabled while the note is on its way, and gives the keyboard up. */
async function tell(
	page: Page,
	agentId: string,
	note: QuotedText,
	done: string,
	onSent: () => void,
	focus?: readonly [went: string, held: string],
): Promise<void> {
	const { ui } = page;
	const reader = CompanyMail.of(page.company);
	if (!reader) return;
	ui.busy = true;
	ui.error = null;
	page.redraw();
	let went = false;
	try {
		const result = await reader.tell(agentId, note);
		onSent();
		went = true;
		ui.busy = false;
		if (result.sent) say(page, done, agentId, focus?.[0]);
		else location.hash = result.href;
	} catch (error) {
		ui.busy = false;
		ui.error = error instanceof Error ? error.message : String(error);
	}
	page.redraw(focus?.[went ? 0 : 1]);
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
		{ class: "mailbox-row is-letter", onclick: wholeLine(() => openLetter(page, letter.folder)) },
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
				letter.snippet ? h("span", { class: "mailbox-snippet" }, dash(), outside(letter.snippet)) : null,
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
	const parts: (HTMLElement | null)[] = [
		h("div", { class: "mailbox-toolbar" }, back),
		h(
			"header",
			{ class: "mailbox-thread-head" },
			letter ? outside(letter.title, "h1") : h("h1", null, t("Digital Post")),
			letter ? h("span", { class: "mailbox-label" }, t("Digital Post")) : null,
		),
		letter
			? h(
					"div",
					{ class: "mailbox-letter-from" },
					h("span", { class: "mailbox-initials", "aria-hidden": "true" }, icon("company")),
					h(
						"span",
						{ class: "mailbox-from" },
						outside(letter.sender, "strong"),
						flags.length ? h("span", { class: "mailbox-flags" }, flags.join(" · ")) : null,
					),
					h("time", { class: "mailbox-when", datetime: letter.received }, fmtTime(letter.received)),
				)
			: null,
	];
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
	const { company } = page;
	const views = manageOf(page);
	const post = digitalPostAddress(page, agentsAtWork(page));
	const postList = post ? h("ul", { class: "mailbox-address-list" }, post) : null;
	if (views)
		return h(
			"div",
			{ class: "mailbox-addresses" },
			h(
				"div",
				{ class: "mailbox-manage" },
				views.hooks.el,
				postList,
				company.store.get().team?.capabilities.authorize === true ? (views.post?.el ?? null) : null,
			),
		);
	// A page without the calls behind the addresses reads them from the mail: each one and who answers it.
	const rows = (company.store.get().mail?.addresses ?? []).map((address) => {
		const [handler] = address.handledBy;
		return h(
			"li",
			{ class: "mailbox-address" },
			h(
				"div",
				{ class: "mailbox-address-row" },
				h("span", { class: "mailbox-address-name" }, h("strong", null, address.address)),
				h(
					"span",
					{ class: "mailbox-address-agent" },
					handler ? figure(page, handler.staffAgentId, handler.name, 30) : null,
					handler
						? t("{name} answers it", { name: agentName(page, handler.staffAgentId, handler.name) })
						: t("No agent answers it yet"),
				),
			),
		);
	});
	return h("div", { class: "mailbox-addresses" }, h("ul", { class: "mailbox-address-list" }, ...rows), postList);
}

/** Whether this member gives addresses to agents here: an owner or admin, on a page that has the calls for it. */
function assigns(page: Page, calls: MailboxManage): boolean {
	return (
		page.company.store.get().team?.capabilities.authorize === true &&
		calls.routines !== undefined &&
		calls.accounts !== undefined
	);
}

/** A chip that opens a menu of agents, as the Writer chip does: the figure of the agent it shows (a plus for none),
 * its words, and the menu `items` makes. `name` is its focus key, and names its menu. While an address is being given
 * or taken (`waits` for the one it is about) every such chip waits. */
function agentChip(
	page: Page,
	name: string,
	agentId: string | null,
	label: string,
	items: () => MenuEntry[],
	waits = false,
): HTMLElement {
	const chip = h(
		"button",
		{
			type: "button",
			class: `mailbox-pick mailbox-answerer${agentId ? " is-current" : ""}`,
			disabled: page.ui.answering !== null,
			"aria-busy": waits ? "true" : null,
			"data-focus-key": name,
		},
		agentId ? figure(page, agentId, undefined, 24) : h("span", { class: "mailbox-nobody" }, icon("plus")),
		h("span", { class: "mailbox-writer-name" }, label),
		icon("chevron-down"),
	);
	menuOn(page, chip, name, t("Who answers it"), items);
	return chip;
}

/** Who answers a mailbox, on its line of Addresses, and how much came to it. An address may have more than one agent:
 * each agent with a routine that starts on its mail answers it, as the cloud lets several listen. An owner or admin
 * has a chip that opens the agents, those who answer it checked: a press gives the address to an agent, or takes it
 * from one (`answerWith`), and nobody else's answering changes. While that is on its way the chip shows the agents as
 * they will be, and waits. Anyone else reads who answers it. What could not be done is said under it. */
function answerer(page: Page, calls: MailboxManage, hook: EventHook): HTMLElement | null {
	const { company, ui } = page;
	const email = hook.email;
	if (!email) return null;
	// A mailbox just made is in the list before the mail is read again: nobody answers it yet.
	const address = company.store.get().mail?.addresses.find((item) => item.address === email);
	const handlers = handlersOf(page, email);
	const nameOf = (agentId: string) =>
		agentName(page, agentId, handlers.find((each) => each.staffAgentId === agentId)?.name);
	const week = address
		? h(
				"span",
				{ class: "mailbox-muted mailbox-address-week" },
				h("strong", { class: "mailbox-week" }, String(address.last7Days)),
				` ${t("in the last 7 days")}`,
			)
		: null;
	const setting = ui.answering?.address === email ? ui.answering : null;
	// Those who answer it, as they will be once what is on its way is done.
	const answering = handlers.map((each) => each.staffAgentId).filter((agentId) => agentId !== setting?.agent);
	if (setting?.on) answering.push(setting.agent);
	const [first, second, ...more] = answering;
	const names = !first
		? null
		: !second
			? nameOf(first)
			: more.length
				? t("{name} and {count} more", { name: nameOf(first), count: more.length + 1 })
				: t("{first} and {second}", { first: nameOf(first), second: nameOf(second) });
	if (!assigns(page, calls))
		return h(
			"div",
			{ class: "mailbox-answer-line" },
			h(
				"span",
				{ class: "mailbox-address-agent" },
				first ? figure(page, first, undefined, 24) : null,
				names ? t("{name} answers it", { name: names }) : t("No agent answers it yet"),
			),
			week,
		);
	const said = ui.answerErrors[email];
	const target = { address: email, hookId: hook.id };
	return h(
		"div",
		{ class: "mailbox-answer-line" },
		h(
			"span",
			{ class: "mailbox-address-agent" },
			first || setting
				? h("span", { class: "mailbox-muted" }, setting ? t("Setting it up") : t("Answered by"))
				: null,
			agentChip(
				page,
				`answerer:${hook.id}`,
				first ?? null,
				names ?? t("Choose who answers"),
				() => {
					// The agents at work, and after them whoever else answers it (an agent no longer at work can be taken off).
					const listed = agentsAtWork(page).map((agent) => agent.id);
					for (const each of handlers) if (!listed.includes(each.staffAgentId)) listed.push(each.staffAgentId);
					return listed.map((agentId): MenuEntry => {
						const on = handlers.some((each) => each.staffAgentId === agentId);
						return {
							label: nameOf(agentId),
							lead: figure(page, agentId, undefined, 22),
							checked: on,
							multiple: true,
							select: () => void answerWith(page, calls, target, agentId, !on),
						};
					});
				},
				setting !== null,
			),
		),
		week,
		said ? h("p", { class: "mailbox-error", role: "alert" }, said) : null,
	);
}

/** Who answers the address the Add form makes: the same chip, in the form, for one agent or nobody. Nobody until the
 * member picks; the new address goes to that agent once it is made. */
function newAnswerer(page: Page, calls: MailboxManage): HTMLElement | null {
	const { ui } = page;
	if (!assigns(page, calls)) return null;
	const chosen = activeAgent(page, ui.addAgent ?? undefined);
	const pick = (agentId: string | null) => () => {
		ui.addAgent = agentId;
		page.redraw("add-answerer");
	};
	return h(
		"div",
		{ class: "mailbox-answer-line is-new" },
		h(
			"span",
			{ class: "mailbox-address-agent" },
			chosen ? h("span", { class: "mailbox-muted" }, t("Answered by")) : null,
			agentChip(page, "add-answerer", chosen?.id ?? null, chosen?.displayName ?? t("Choose who answers"), () => {
				const agents = agentsAtWork(page);
				const items: MenuEntry[] = [
					{
						label: t("Nobody"),
						lead: h("span", { class: "mailbox-nobody" }),
						checked: !chosen,
						select: pick(null),
					},
				];
				if (agents.length) items.push({ kind: "separator" });
				for (const agent of agents)
					items.push({
						label: agent.displayName,
						lead: figure(page, agent.id, undefined, 22),
						checked: agent.id === chosen?.id,
						select: pick(agent.id),
					});
				return items;
			}),
		),
	);
}

/** The member's own model account an agent's answering runs on: one that works while they are away, else the first
 * that can pay for work that starts on its own (never a Claude login or a ChatGPT plan), as a routine's editor picks. */
function payingAccount(connections: NativeExecutionConnections) {
	const able = latestVersions(
		connections.connections.filter(
			(item) => item.connectionStatus === "active" && item.authorizationState === "active" && !claudeLogin(item),
		),
	).filter((item) => canPayForRoutine(item, true));
	return able.find((item) => item.allowAutonomous === true) ?? able[0];
}

/** Gives an address to an agent (`on`), or takes it from one. With none on its way it starts at once, so its chip
 * waits from the press on. With one on its way (a new address made meanwhile) it takes its turn after it, and is not
 * lost. */
function answerWith(
	page: Page,
	calls: MailboxManage,
	target: { readonly address: string; readonly hookId: string },
	agentId: string,
	on: boolean,
): Promise<void> {
	const before = page.ui.answering ? answerings.get(page.ui) : undefined;
	const turn = before
		? before.then(() => giveAddress(page, calls, target, agentId, on))
		: giveAddress(page, calls, target, agentId, on);
	answerings.set(page.ui, turn);
	return turn;
}

/** The routines that start on mail to a mailbox, as the routine list gives them now. */
async function listeners(routines: NonNullable<MailboxManage["routines"]>, hookId: string): Promise<WebRoutine[]> {
	return (await routines.list()).filter((routine) =>
		routine.triggers.some(
			(trigger) => trigger.kind === "listener" && trigger.source === "event" && trigger.hookId === hookId,
		),
	);
}

/** The routine changed last comes first: the cloud's own times, and the ids where two are the same. */
function newestFirst(a: WebRoutine, b: WebRoutine): number {
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.routineId < b.routineId ? -1 : 1);
}

/** Gives an address to an agent, or takes it from one. An agent answers an address through a routine of its own that
 * starts on mail to it, written here as the member's own save (cloud/routines.ts), on their own model account.
 *
 * One agent's answering is one thing, and nobody else's changes with it: an address may have several agents, as the
 * cloud lets several routines listen to a mailbox, and the line names them all. So nothing here is a handover in
 * steps that could stop half way and leave an address with nobody, or with an agent the member did not see.
 *
 * - Giving: an agent that answered the address before takes up the routine it had last. One that stays paused (it
 *   waits for a login only its own page moves: who pays for a routine is never switched here) is left, and the agent
 *   gets a new one. With no model account that can pay, nothing is written.
 * - Taking: each routine of the agent's that starts on the address's mail stops.
 * - What the cloud holds after decides what is said, whatever was heard back: a save or a stop whose answer was lost
 *   has still happened, and a routine that is not at work after its save answers nothing. The address is said to be
 *   the agent's only once a routine of the agent's is at work.
 * - Two members may give one address to the same agent at the same moment, and the agent would wake twice for each
 *   email. Of the routines this began and those begun meanwhile, the one the cloud saved last is kept, here and on
 *   the other member's page, and the others stop. A routine at work before is nobody's to stop here.
 *
 * The company's mail is read again after, so the line says who answers it now. What could not be done is kept for the
 * address's line; nothing is thrown. */
async function giveAddress(
	page: Page,
	calls: MailboxManage,
	target: { readonly address: string; readonly hookId: string },
	agentId: string,
	on: boolean,
): Promise<void> {
	const { company, ui } = page;
	const { routines, accounts } = calls;
	const agent = activeAgent(page, agentId);
	// Only an agent at work is given an address; any agent that answers one can be taken off it.
	if (!routines || !accounts || (on && !agent)) return;
	const name = agentName(page, agentId);
	const focus = `answerer:${target.hookId}`;
	ui.answering = { address: target.address, agent: agentId, on };
	const { [target.address]: _said, ...rest } = ui.answerErrors;
	ui.answerErrors = rest;
	page.redraw();
	const atWork = (routine: WebRoutine) => routine.status === "active";
	const own = async () =>
		(await listeners(routines, target.hookId)).filter((routine) => routine.staffAgentId === agentId);
	const stop = (routine: WebRoutine) => routines.setEnabled(routine, undefined, false, crypto.randomUUID());
	// The agent's routines at work before, and whether this began one: a routine taken up again, or a new one.
	let wasAtWork = new Set<string>();
	let began = false;
	let failure: unknown;
	try {
		const before = await own();
		wasAtWork = new Set(before.filter(atWork).map((routine) => routine.routineId));
		if (!on) for (const routine of before) if (atWork(routine)) await stop(routine);
		if (on && !wasAtWork.size) {
			const account = payingAccount(await accounts(company.signal));
			if (!account)
				throw new Error(
					t(
						"An agent answers email by itself on one of your own model accounts, and none of yours can pay for that. Connect one in Settings → AI subscriptions.",
					),
				);
			const [paused] = before.filter((routine) => routine.status === "paused").sort(newestFirst);
			began = true;
			if (paused) await routines.setEnabled(paused, account, true, crypto.randomUUID());
			if (!paused || !(await own()).some((routine) => routine.routineId === paused.routineId && atWork(routine))) {
				await routines.save(
					{
						clientRoutineId: crypto.randomUUID(),
						staffAgentId: agentId,
						title: t("Answer email to {address}", { address: target.address }),
						prompt: t(
							"Read each email that arrives at {address} and handle it for the company. Answer the sender when the email needs an answer, as a reply to that email. Leave automatic email, and email that needs no answer, unanswered. When you can't settle something yourself, tell the member who should, and say what you need.",
							{ address: target.address },
						),
						trigger: {
							id: "file",
							kind: "listener",
							source: "event",
							hookId: target.hookId,
							only: ["mail.received"],
							timeZone: presentationTimeZone(),
							// It answers the sender, not the member: it writes in its thread only when it has something to say.
							replyPolicy: "optional",
						},
						effort: "low",
					},
					account,
					crypto.randomUUID(),
				);
			}
		}
	} catch (error) {
		failure = error;
	}
	// What the cloud holds now decides, whatever was heard back.
	let held: { readonly answers: boolean; readonly twice: boolean } | null = null;
	let unread: unknown;
	try {
		let now = (await own()).filter(atWork);
		// The routines begun for this agent just now, here and by another member: the one saved last stays. A stop that
		// fails is tried once more, and the routines are read again: what is still at work then is said, not passed over.
		const older =
			on && began
				? now
						.filter((routine) => !wasAtWork.has(routine.routineId))
						.sort(newestFirst)
						.slice(1)
				: [];
		if (older.length) {
			for (const routine of older)
				await stop(routine)
					.catch(() => stop(routine))
					.catch(() => {});
			now = (await own()).filter(atWork);
		}
		held = {
			answers: now.length > 0,
			twice: older.some((routine) => now.some((each) => each.routineId === routine.routineId)),
		};
	} catch (error) {
		unread = error;
	}
	// The addresses are read afresh, so the line says who answers it now. Where they can't be read, the line goes by
	// what the routines just said until they can: it never goes back to what was before the change.
	const fresh = (await CompanyMail.of(company)?.addressesAfresh()) === true;
	const kept = answeredBy.get(ui) ?? new Map();
	answeredBy.set(ui, kept);
	if (fresh) kept.delete(target.address);
	else if (held) {
		const agents = handlersOf(page, target.address)
			.map((each) => each.staffAgentId)
			.filter((each) => each !== agentId);
		if (held.answers) agents.push(agentId);
		kept.set(target.address, { agents, read: company.store.get().mail?.addresses });
	}
	const listed = handlersOf(page, target.address);
	ui.answering = null;
	const reached = held !== null && held.answers === on;
	if (held && reached && !held.twice) {
		say(
			page,
			!on
				? t("{name} no longer answers {address}", { name, address: target.address })
				: listed.some((each) => each.staffAgentId !== agentId)
					? t("{name} answers {address} too", { name, address: target.address })
					: t("{name} answers {address}", { name, address: target.address }),
			on ? agentId : null,
			focus,
		);
		return;
	}
	// A refusal saved nothing; the file's or the mailbox's problems say why, in English.
	ui.answerErrors = {
		...ui.answerErrors,
		[target.address]: !held
			? describeError(unread)
			: held.twice
				? t(
						"{name} has more than one routine for this address at work, and wakes more than once for an email. Take {name} off the address and give it to {name} again.",
						{ name },
					)
				: failure instanceof WebCompanyFolderRejectedError
					? withProblems(t("The address could not be given to the agent."), failure.problems)
					: failure !== undefined
						? describeError(failure)
						: on
							? t("{name}'s routine for this address did not start. {name}'s routines say why.", { name })
							: t("It could not be changed. Try again."),
	};
	page.redraw(focus);
}

// Writing an email ------------------------------------------------------------------------------------------------

/** Adds to who an email goes to on one of its lines, none of them twice, and returns the ones added. */
function addRecipients(list: Recipients, texts: readonly string[]): string[] {
	const added: string[] = [];
	for (const text of texts) {
		const recipient = text.trim();
		if (!recipient || list.chips.some((each) => each.toLowerCase() === recipient.toLowerCase())) continue;
		list.chips.push(recipient);
		added.push(recipient);
	}
	return added;
}

/** The member changed their email: what was said about the last try goes. */
function edited(draft: Draft, field: Element): void {
	if (!draft.error) return;
	draft.error = null;
	field.closest("form")?.querySelector(".mailbox-write-error")?.remove();
}

/** Who the email goes to (`to`) or is copied to (`cc`): a chip for each one, and the field the next one is typed in,
 * which `key` names for the focus. An address becomes a chip at the space after it; anything typed does at a comma, a
 * semicolon, Enter or when the field is left. The member's own email goes to addresses, so there a chip that is no
 * email address is marked; an agent (`named`) reads a name too, and with one as the writer no chip is. The row is the
 * same for both, and a change of writer changes nothing in it: no chip is turned back into text and read again, so one
 * that is no address stays so. Chips come and go in place, so the field keeps the focus; a redraw draws them from the
 * same list. While the email, or the words to its agent, are on their way the field and each chip's button are
 * disabled. */
function recipientsRow(page: Page, draft: Draft, line: "to" | "cc", named: boolean, key: string): HTMLElement {
	const { ui } = page;
	const list = draft[line];
	const label = line === "to" ? t("To") : t("Cc");
	const input = h("input", {
		value: list.typed,
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		inputmode: named ? undefined : "email",
		disabled: ui.busy,
		"aria-label": label,
		"data-focus-key": key,
	});
	const hint = () => {
		input.placeholder =
			list.chips.length || line === "cc" ? "" : named ? t("Name or email address") : t("Email address");
	};
	const chip = (recipient: string): HTMLElement => {
		const wrong = named || isAddress(recipient) ? null : t("Not an email address");
		const drawn: HTMLElement = h(
			"span",
			{ class: `mailbox-chip${wrong ? " is-invalid" : ""}`, title: wrong },
			h("span", { class: "mailbox-chip-text" }, recipient),
			wrong ? h("span", { class: "visually-hidden" }, wrong) : null,
			h(
				"button",
				{
					type: "button",
					class: "mailbox-chip-remove",
					disabled: ui.busy,
					"aria-label": t("Remove {name}", { name: recipient }),
					onclick: () => {
						const index = list.chips.indexOf(recipient);
						if (index >= 0) list.chips.splice(index, 1);
						drawn.remove();
						edited(draft, input);
						hint();
						input.focus();
					},
				},
				icon("close"),
			),
		);
		return drawn;
	};
	const add = (texts: readonly string[]) => {
		for (const recipient of addRecipients(list, texts)) input.before(chip(recipient));
		hint();
	};
	/** What is typed becomes a chip. */
	const take = () => {
		if (!input.value.trim()) return;
		add(asRecipients(input.value));
		input.value = "";
		list.typed = "";
		edited(draft, input);
	};
	input.addEventListener("input", (event) => {
		edited(draft, input);
		// A word being composed is still being typed.
		if (!(event as InputEvent).isComposing) {
			// A comma or a semicolon ends what stands before it, but not one inside a quoted name or a remark, closed or
			// still open ('"Holm, Anna'). A space ends an address, and never a name, whose next word may follow ("Nordlys
			// Energi"); what stands after is still being typed. Nor does it end an address that has a mark after it, when
			// that much comes in at once (dropped in, say): there it may be the name ("old@acme.dk <anna@acme.dk>").
			const cut = entriesOf(input.value).at(-2)?.end ?? 0;
			const ended = asRecipients(input.value.slice(0, cut));
			const rest = input.value.slice(cut);
			const words = rest.trimStart().split(/\s+/);
			let spaced = 0;
			if (!/[<"(]/.test(rest)) while (spaced < words.length - 1 && isAddress(words[spaced] ?? "")) spaced += 1;
			if (cut || spaced) {
				add([...ended, ...words.slice(0, spaced)]);
				input.value = words.slice(spaced).join(" ");
			}
		}
		list.typed = input.value;
	});
	input.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
			// Enter ends an address; it does not send the email from here.
			event.preventDefault();
			take();
		} else if (event.key === "Backspace" && !input.value && list.chips.length) {
			list.chips.pop();
			input.previousElementSibling?.remove();
			edited(draft, input);
			hint();
		}
	});
	// Leaving the field ends an address too. Not when a redraw takes the field away, or the window loses the focus:
	// what is half typed then stays typed.
	input.addEventListener("blur", () => {
		queueMicrotask(() => {
			if (input.isConnected && document.activeElement !== input) take();
		});
	});
	// A pasted list ("Anna <anna@acme.dk>, bo@acme.dk") becomes a chip for each of its entries, read together with what
	// is typed around it. An agent takes a name as well as an address, so for one the list is read as if it were typed,
	// and no name in it is left out ("Nordlys Energi bo@acme.dk" is both). A piece of one address, or a name alone, is
	// typed on as the field takes it.
	input.addEventListener("paste", (event) => {
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		const pasted = event.clipboardData?.getData("text") ?? "";
		if (!pasted.trim()) return;
		const found = (named ? asRecipients : pastedRecipients)(
			input.value.slice(0, start) + pasted + input.value.slice(end),
		);
		if (found.length < 2 && !found.some(isAddress)) return;
		event.preventDefault();
		add(found);
		input.value = "";
		list.typed = "";
		edited(draft, input);
	});
	hint();
	return h(
		"div",
		{
			class: "mailbox-write-row mailbox-write-to",
			// A press beside the chips writes the next address.
			onclick: (event: MouseEvent) => {
				if (!(event.target as Element).closest("button, input")) input.focus();
			},
		},
		h("span", { class: "mailbox-write-label", "aria-hidden": "true" }, label),
		...list.chips.map(chip),
		input,
	);
}

/** The signed-in member's own picture: who writes an email until an agent has it. */
function ownFace(page: Page): HTMLElement {
	const { company } = page;
	const me = company.store.get().team?.members.find((member) => member.userId === company.userId)?.displayName;
	return personAvatar(me || t("You"), company.userId);
}

/** Gives a chip its menu, opened under it and named by the chip's focus key. */
function menuOn(page: Page, chip: HTMLElement, name: string, label: string, items: () => MenuEntry[]): void {
	const { ui } = page;
	chip.setAttribute("aria-haspopup", "menu");
	chip.setAttribute("aria-expanded", String(chipMenus.get(ui) === name));
	const open = () => {
		const container = chip.closest(".mailbox")?.parentElement;
		// A redraw under the open menu draws the chip again.
		const drawn = () =>
			chip.isConnected ? chip : (container?.querySelector<HTMLElement>(`[data-focus-key="${name}"]`) ?? null);
		const box = chip.getBoundingClientRect();
		openContextMenu({
			label,
			x: box.left,
			y: box.bottom + 4 * uiScale(),
			opener: chip,
			findOpener: drawn,
			onClose: (press) => {
				chipMenus.delete(ui);
				if (press) chipPresses.set(ui, { chip: name, press });
				else chipPresses.delete(ui);
				drawn()?.setAttribute("aria-expanded", "false");
			},
			items: items(),
		});
		// After it opened: opening shuts any menu open before it, and that menu's close would take this mark with it.
		chipMenus.set(ui, name);
		chip.setAttribute("aria-expanded", "true");
	};
	// A press on the chip while its menu is open only shuts the menu: the menu says which press shut it, and the click
	// that press ends in opens nothing (as an agent's menu on the Members page). A click from the keyboard has no
	// press before it.
	let shuts = false;
	chip.addEventListener("pointerdown", (event) => {
		const shut = chipPresses.get(ui);
		shuts = shut?.chip === name && shut.press === event;
	});
	chip.addEventListener("click", (event) => {
		const shut = shuts && event.detail > 0;
		shuts = false;
		if (!shut) open();
	});
}

/** The Writer chip of an email being written: the member's own picture until an agent has the email, and the menu
 * that gives it to one. `name` is the chip's focus key. While the email, or the words to its agent, are on their way,
 * nothing about it can be changed: it is what was sent that leaves its window when it has gone, and a change made
 * meanwhile would go with it unsent. */
function writerChip(page: Page, draft: Draft, name: string): HTMLElement {
	const { ui } = page;
	const agents = agentsAtWork(page);
	const chosen = agents.find((agent) => agent.id === draft.writer);
	const writer = h(
		"button",
		{
			type: "button",
			class: `mailbox-pick mailbox-writer${chosen ? " is-current" : ""}`,
			disabled: ui.busy,
			"data-focus-key": name,
		},
		chosen ? figure(page, chosen.id, undefined, 24) : ownFace(page),
		h("span", { class: "mailbox-writer-name" }, chosen ? chosen.displayName : t("You")),
		icon("chevron-down"),
	);
	const pick = (id: string | null) => {
		// A menu left open over the window when the email went picks nothing.
		if (ui.busy) return;
		// Who it goes to stays as it stands: each chip what it was made as, and what is typed after them still typed.
		draft.writer = id;
		draft.error = null;
		page.redraw(name);
	};
	menuOn(page, writer, name, t("Who writes it"), () => {
		// Each row has its writer's picture, as the chip has; the one who has the email carries the check.
		const items: MenuEntry[] = [{ label: t("You"), lead: ownFace(page), checked: !chosen, select: () => pick(null) }];
		if (agents.length) items.push({ kind: "separator" });
		for (const agent of agents)
			items.push({
				label: agent.displayName,
				lead: figure(page, agent.id, undefined, 22),
				checked: agent.id === chosen?.id,
				select: () => pick(agent.id),
			});
		return items;
	});
	return writer;
}

/** How an email being written goes as the member's own: what its window gives beside the draft. */
interface OwnSend {
	/** The company's address it goes from. */
	readonly from: string | undefined;
	readonly subject: string;
	/** The message it answers, for an answer in a thread. */
	readonly replyTo?: MailMessageRef;
	/** The focus keys of its window's fields: what holds the email back gives the focus to the field it is about. */
	readonly keys: {
		readonly from: string;
		readonly to: string;
		readonly cc: string;
		readonly subject: string;
		readonly text: string;
		readonly send: string;
	};
	/** The email has gone: its draft is let go. */
	readonly gone: () => void;
	/** The email did not go: its window is on screen again, if the member left it meanwhile. */
	readonly kept: () => void;
	/** What is said when it has gone, and the control that then has the focus. */
	readonly done: readonly [text: string, focus: string];
}

/** Sends an email being written as the member's own, from the company's address (contract, M2e). */
async function sendOwn(page: Page, draft: Draft, how: OwnSend): Promise<void> {
	const { company, ui } = page;
	const reader = CompanyMail.of(company);
	if (!reader) return;
	// What is still typed after the chips goes with them.
	for (const list of [draft.to, draft.cc]) {
		addRecipients(list, asRecipients(list.typed));
		list.typed = "";
	}
	const to = [...draft.to.chips];
	// Whoever the email goes to is not sent a copy as well.
	const cc = draft.cc.chips.filter((copy) => !to.some((each) => each.toLowerCase() === copy.toLowerCase()));
	const wrong = [...to, ...cc].find((recipient) => !isAddress(recipient));
	const subject = how.subject.replace(/\s+/g, " ").trim();
	const { from, keys } = how;
	// What holds the email back, said in the window, with the focus on the field it is about.
	const held: readonly [why: string, field: string] | null = !from
		? [t("The company has no email address yet"), keys.from]
		: !to.length
			? [t("Add who the email goes to"), keys.to]
			: wrong
				? [t("{address} is not an email address", { address: wrong }), to.includes(wrong) ? keys.to : keys.cc]
				: to.length + cc.length > MOST_RECIPIENTS
					? [t("An email goes to at most {count} addresses", { count: MOST_RECIPIENTS }), keys.to]
					: !subject
						? [t("The email needs a subject"), keys.subject]
						: !draft.text.trim()
							? [t("The email needs its text"), keys.text]
							: null;
	if (held || !from) {
		draft.error = held?.[0] ?? null;
		page.redraw(held?.[1]);
		return;
	}
	// The email as it leaves, in every part. Sent again as it stands after a try that failed, it is the same email
	// and keeps its id, so the cloud sends it once; changed since in any part, by any way, it is a new one.
	const email = {
		from,
		to,
		...(cc.length ? { cc } : {}),
		subject,
		text: draft.text.trimEnd(),
		...(how.replyTo ? { replyTo: how.replyTo } : {}),
	};
	const written = JSON.stringify(email);
	if (draft.send?.email !== written) draft.send = { id: crypto.randomUUID(), email: written };
	const sendId = draft.send.id;
	ui.busy = true;
	draft.error = null;
	page.redraw();
	/** The email did not go: its window says why and keeps it, on screen again if it was left meanwhile. */
	const kept = (why: string) => {
		ui.busy = false;
		how.kept();
		draft.error = why;
		page.redraw(keys.send);
	};
	try {
		const receipt = await reader.send({ sendId, ...email });
		// Only an email queued by an earlier try answers with how it ended. One that did not go is not sent by asking
		// for it again: the member is told, and their next Send is a new email.
		const ended =
			receipt.status === "failed"
				? t("This email could not be sent. Send it again to try once more.")
				: receipt.status === "cancelled"
					? t("This email was cancelled before it went. Send it again if it should still go.")
					: null;
		if (ended) {
			draft.send = null;
			kept(ended);
			return;
		}
		how.gone();
		ui.busy = false;
		say(page, how.done[0], null, how.done[1]);
	} catch (error) {
		kept(describeError(error));
	}
}

// Write -------------------------------------------------------------------------------------------------------------

function writePanel(page: Page): HTMLElement {
	const { company, ui } = page;
	const draft = ui.write;
	// A new email is nobody's: the member writes and sends it themself until they give it to an agent.
	const chosen = agentsAtWork(page).find((agent) => agent.id === draft.writer);
	const addresses = company.store.get().mail?.addresses ?? [];
	// The member's own email goes from an address in use; a paused one stands in only when none is, and the cloud then
	// says why the email cannot go.
	const inUse = addresses.filter((address) => address.status === "active");
	const own = inUse.length ? inUse : addresses;
	// An agent's email goes from the address its writer answers, else from the company's first; the member's own from the
	// one they picked, else from the first.
	const from = (
		chosen
			? (addresses.find((address) => address.handledBy.some((each) => each.staffAgentId === chosen.id)) ??
				addresses[0])
			: (own.find((address) => address.address === draft.from) ?? own[0])
	)?.address;
	const close = () => {
		ui.writing = false;
		page.redraw("write");
	};
	// The From chip: which of the company's addresses the member's own email goes from, when there is a choice.
	const sender =
		!chosen && from && own.length > 1
			? h(
					"button",
					{ type: "button", class: "mailbox-pick mailbox-sender", disabled: ui.busy, "data-focus-key": "from" },
					h("span", { class: "mailbox-sender-name" }, from),
					icon("chevron-down"),
				)
			: null;
	if (sender)
		menuOn(page, sender, "from", t("Which address it goes from"), () =>
			own.map((address) => ({
				label: address.address,
				checked: address.address === from,
				select: () => {
					if (ui.busy) return;
					draft.from = address.address;
					draft.error = null;
					page.redraw("from");
				},
			})),
		);
	const sent = () => {
		ui.writing = false;
		ui.write = newDraft();
	};
	const submit = async () => {
		if (ui.busy) return;
		if (!chosen) {
			await sendOwn(page, draft, {
				from,
				subject: draft.subject,
				keys: {
					from: "writer",
					to: "write-to",
					cc: "write-to",
					subject: "write-subject",
					text: "write-text",
					send: "write-send",
				},
				gone: sent,
				// Open again if it was shut meanwhile.
				kept: () => {
					ui.writing = true;
				},
				done: [t("Your email is on its way"), "write"],
			});
			return;
		}
		// An agent reads who it goes to as words: the chips, and what is typed after them.
		const to = [...draft.to.chips, draft.to.typed.trim()].filter(Boolean).join(", ");
		const words = draft.text.trim();
		if (!to || !words) return;
		await tell(
			page,
			chosen.id,
			{
				text: from
					? t("Please write an email to {to} from {from}: {words}", { to, from, words })
					: t("Please write an email to {to}: {words}", { to, words }),
				quotes: [],
			},
			t("{name} is writing it", { name: chosen.displayName }),
			sent,
			["write", "write-send"],
		);
	};
	return h(
		"form",
		{
			class: "mailbox-write-panel",
			role: "dialog",
			"aria-labelledby": "mailbox-write-title",
			// On a short page the window scrolls, and so does its text: a redraw leaves both where they were (show).
			"data-scroll-key": "write",
			onsubmit: (event: Event) => {
				event.preventDefault();
				void submit();
			},
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === "Escape") close();
				// Cmd or Ctrl with Enter sends from any field, as in a mail app.
				else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
					event.preventDefault();
					void submit();
				}
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
			{ class: "mailbox-write-row", role: "group", "aria-label": t("Who writes it") },
			h("span", { class: "mailbox-write-label" }, t("Writer")),
			writerChip(page, draft, "writer"),
		),
		sender
			? h(
					"div",
					{ class: "mailbox-write-row", role: "group", "aria-label": t("Which address it goes from") },
					h("span", { class: "mailbox-write-label" }, t("From")),
					sender,
				)
			: null,
		recipientsRow(page, draft, "to", Boolean(chosen), "write-to"),
		// An agent writes the subject of its own email; the member writes theirs.
		chosen
			? null
			: h(
					"label",
					{ class: "mailbox-write-row" },
					h("span", { class: "mailbox-write-label" }, t("Subject")),
					h("input", {
						value: draft.subject,
						maxlength: "200",
						autocomplete: "off",
						disabled: ui.busy,
						"data-focus-key": "write-subject",
						oninput: (event: Event) => {
							const field = event.target as HTMLInputElement;
							draft.subject = field.value;
							edited(draft, field);
						},
						onkeydown: (event: KeyboardEvent) => {
							// Enter goes on to the text; it does not send an email half written.
							if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.isComposing) return;
							event.preventDefault();
							(event.currentTarget as HTMLElement).closest("form")?.querySelector("textarea")?.focus();
						},
					}),
				),
		h(
			"label",
			{ class: "mailbox-write-text" },
			h("span", { class: "visually-hidden" }, chosen ? t("What should it say") : t("Write your email")),
			h(
				"textarea",
				{
					rows: "11",
					maxlength: chosen ? undefined : "20000",
					placeholder: chosen ? t("What should it say?") : t("Write your email"),
					disabled: ui.busy,
					"data-focus-key": "write-text",
					"data-scroll-key": "write-text",
					oninput: (event: Event) => {
						const field = event.target as HTMLTextAreaElement;
						draft.text = field.value;
						edited(draft, field);
					},
				},
				draft.text,
			),
		),
		draft.error ? h("p", { class: "mailbox-write-error", role: "alert" }, draft.error) : null,
		h(
			"div",
			{ class: "mailbox-write-foot" },
			h(
				"button",
				{ type: "submit", class: "mailbox-primary", disabled: ui.busy, "data-focus-key": "write-send" },
				chosen ? t("Ask {name} to write it", { name: chosen.displayName }) : ui.busy ? t("Sending") : t("Send"),
			),
			// Beside it: who sends it, and from which of the company's addresses (the From chip says so when it shows).
			chosen
				? h(
						"span",
						{ class: "mailbox-muted" },
						`${t("{name} writes and sends it", { name: chosen.displayName })} `,
						from ? h("span", { class: "mailbox-from-address" }, t("from {address}", { address: from })) : null,
					)
				: from && !sender
					? h(
							"span",
							{ class: "mailbox-muted" },
							h("span", { class: "mailbox-from-address" }, t("from {address}", { address: from })),
						)
					: null,
		),
	);
}

// An answer in a thread ---------------------------------------------------------------------------------------------

/** One of the company's own addresses, tagged or not: a company never emails its own mailboxes. */
function ownAddress(page: Page, address: string): boolean {
	const plain = address.toLowerCase().replace(/\+[^@]*(?=@)/, "");
	return (page.company.store.get().mail?.addresses ?? []).some((own) => own.address.toLowerCase() === plain);
}

/** The addresses among `listed` ("Anna Holm <anna@acme.dk>" is its address), each once, without the company's own and
 * without those in `known`. What is no address is left out: nobody typed it. */
function outsiders(page: Page, listed: readonly string[], known: readonly string[] = []): string[] {
	const found: string[] = [];
	for (const address of listed.flatMap(pastedRecipients).filter(isAddress)) {
		const again = [...known, ...found].some((each) => each.toLowerCase() === address.toLowerCase());
		if (!again && !ownAddress(page, address)) found.push(address);
	}
	return found;
}

/** Who an answer to `message` goes to. A reply to a received email goes to where the email asks its answers to go (its
 * Reply-To), else to who sent it; a reply to an email the company sent follows it up, to who that went to. To all,
 * everyone else the message went to has it too, as it had them: in To or as a copy. */
function answerRecipients(page: Page, message: MailMessage, all: boolean): { to: string[]; cc: string[] } {
	if (message.kind === "sent") {
		const to = outsiders(page, message.to);
		return { to, cc: all ? outsiders(page, message.cc, to) : [] };
	}
	// An email from an address nobody reads ("no-reply@") names where its answers go: they go there, not to its sender.
	const asked = outsiders(page, message.replyTo);
	const sender = asked.length ? asked : outsiders(page, message.fromAddress ? [message.fromAddress] : []);
	if (!all) return { to: sender, cc: [] };
	const to = [...sender, ...outsiders(page, message.to, sender)];
	return { to, cc: outsiders(page, message.cc, to) };
}

/** An answer's subject: the message's own behind "Re:" or "Fwd:", said once, on one line of at most 200 characters (as
 * the cloud takes a subject). */
function answerSubject(subject: string | undefined, forward: boolean): string {
	const plain = (subject ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim() || t("(no subject)");
	const marked = (forward ? /^fwd?:/i : /^re:/i).test(plain);
	return [...(marked ? plain : `${forward ? "Fwd" : "Re"}: ${plain}`)].slice(0, 200).join("");
}

/** A message sent on to someone else: its sender, day and time, subject, recipients and text, as a mail app sets them
 * under the member's own words, cut to the length an email's text may have. */
function forwarded(message: MailMessage, summary: MailThreadSummary): string {
	const to = message.kind === "received" && !message.to.length ? [summary.address] : message.to;
	const sent = new Date(message.at).toLocaleString(presentationLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: presentationTimeZone(),
	});
	const lines = [
		`---------- ${t("Forwarded message")} ----------`,
		`${t("From")}: ${senderOf(message)}`,
		`${t("Date")}: ${sent}`,
		`${t("Subject")}: ${message.subject ?? summary.subject ?? ""}`,
		`${t("To")}: ${to.join(", ")}`,
		...(message.cc.length ? [`${t("Cc")}: ${message.cc.join(", ")}`] : []),
		"",
		message.text ?? "",
	];
	return [...`\n\n${lines.join("\n")}`].slice(0, 20_000).join("");
}

/** Under a thread's messages: Reply, Reply all and Forward, as a mail app has them, or the answer one of them opened.
 * They answer the thread's newest message. Reply all shows when it goes to more than Reply does. Account mail shows
 * no text and is not answered, and a member who may not write in the company answers nothing. */
function replyArea(
	page: Page,
	thread: string,
	summary: MailThreadSummary | undefined,
	newest: MailMessage | undefined,
): HTMLElement | null {
	const { ui } = page;
	if (!canWrite(page) || !summary || summary.account || !newest) return null;
	if (newest.kind === "received" && newest.account) return null;
	const reply = ui.replies[thread];
	if (reply) return replyBox(page, thread, summary, reply);
	const one = answerRecipients(page, newest, false);
	const everyone = answerRecipients(page, newest, true);
	const answer = (kind: Reply["kind"], label: string, glyph: string) =>
		h(
			"button",
			{
				type: "button",
				class: "mailbox-answer",
				"data-focus-key": `answer:${kind}`,
				onclick: (event: MouseEvent) => {
					const root = (event.currentTarget as HTMLElement).closest(".mailbox")?.parentElement;
					const forward = kind === "forward";
					const { to, cc } = forward ? { to: [], cc: [] } : kind === "all" ? everyone : one;
					ui.replies = {
						...ui.replies,
						[thread]: {
							...newDraft(),
							kind,
							message: { kind: newest.kind, id: newest.id },
							// It goes from the thread's own address, kept with the answer (`replyBox`).
							from: summary.address,
							to: { chips: [...to], typed: "" },
							cc: { chips: [...cc], typed: "" },
							subject: answerSubject(newest.subject ?? summary.subject, forward),
							text: forward ? forwarded(newest, summary) : "",
						},
					};
					// The member writes on where something is missing: who a forward goes to, else the text.
					page.redraw(to.length ? "reply-text" : "reply-to");
					// The answer opens under the thread: all of it comes into view, as far as the page has room.
					root?.querySelector(".mailbox-reply")?.scrollIntoView?.({ block: "nearest" });
				},
			},
			icon(glyph),
			label,
		);
	return h(
		"div",
		{ class: "mailbox-answers" },
		answer("reply", t("Reply"), "reply"),
		everyone.to.length + everyone.cc.length > one.to.length ? answer("all", t("Reply all"), "reply_all") : null,
		answer("forward", t("Forward"), "forward"),
	);
}

/** An answer being written at the foot of its thread, as a mail app's reply box: who it goes to as chips, its text,
 * Send and, at the foot's end, the bin that lets it go. Send sends it as the member's own email from the thread's
 * address, in the thread (a forward as a new email). That address is the answer's from the moment it is opened: no
 * other address stands in when it is paused or gone meanwhile (the cloud then says so), so the answer never leaves
 * from somewhere the member did not see, and sent again as it stands it is the same email. The Writer chip gives a
 * reply to an agent instead: the member's words go to that agent as their own message, with the email's subject and
 * sender as quotes, and the agent answers whoever it finds right. */
function replyBox(page: Page, thread: string, summary: MailThreadSummary, reply: Reply): HTMLElement {
	const { ui } = page;
	const forward = reply.kind === "forward";
	// A forward is the member's own email: an agent answers an email, and sends none on.
	const chosen = forward ? undefined : agentsAtWork(page).find((agent) => agent.id === reply.writer);
	const from = reply.from ?? summary.address;
	const [label, glyph] =
		reply.kind === "all"
			? [t("Reply all"), "reply_all"]
			: forward
				? [t("Forward"), "forward"]
				: [t("Reply"), "reply"];
	const drop = () => {
		const { [thread]: _gone, ...rest } = ui.replies;
		ui.replies = rest;
	};
	const submit = async () => {
		if (ui.busy) return;
		if (!chosen) {
			await sendOwn(page, reply, {
				from,
				subject: reply.subject,
				...(forward ? {} : { replyTo: reply.message }),
				keys: {
					from: "reply-send",
					to: "reply-to",
					cc: "reply-cc",
					subject: "reply-send",
					text: "reply-text",
					send: "reply-send",
				},
				gone: drop,
				// Back in its thread if the member left it meanwhile.
				kept: () => {
					ui.open = thread;
					ui.letter = null;
				},
				done: [forward ? t("Your email is on its way") : t("Your reply is on its way"), "answer:reply"],
			});
			return;
		}
		const words = reply.text.trim();
		const quoted = messageText(
			t("Please answer the email {subject} from {from_name}: "),
			mailRow(summary),
			"mail",
			(_column, value) => String(value ?? ""),
		);
		if (!words || !quoted) return;
		await tell(
			page,
			chosen.id,
			{ text: `${quoted.text}${words}`, quotes: quoted.quotes },
			t("{name} is writing it", { name: chosen.displayName }),
			drop,
			["answer:reply", "reply-send"],
		);
	};
	return h(
		"div",
		{ class: "mailbox-reply" },
		chosen ? figure(page, chosen.id, undefined, 40) : ownFace(page),
		h(
			"form",
			{
				class: "mailbox-reply-box",
				"aria-label": label,
				onsubmit: (event: Event) => {
					event.preventDefault();
					void submit();
				},
				onkeydown: (event: KeyboardEvent) => {
					// Cmd or Ctrl with Enter sends from any field, as in a mail app.
					if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
					event.preventDefault();
					void submit();
				},
			},
			h(
				"div",
				{ class: "mailbox-reply-head" },
				h("span", { class: "mailbox-reply-kind" }, icon(glyph), label),
				forward ? null : writerChip(page, reply, "reply-writer"),
			),
			// An agent answers whoever it finds right; the member's own answer goes to who the chips say.
			chosen ? null : recipientsRow(page, reply, "to", false, "reply-to"),
			!chosen && (reply.cc.chips.length || reply.cc.typed)
				? recipientsRow(page, reply, "cc", false, "reply-cc")
				: null,
			h(
				"label",
				{ class: "mailbox-write-text" },
				h(
					"span",
					{ class: "visually-hidden" },
					chosen ? t("What should it say") : forward ? t("Write your email") : t("Write your reply"),
				),
				h(
					"textarea",
					{
						rows: "6",
						maxlength: chosen ? undefined : "20000",
						placeholder: chosen
							? t("What should it say?")
							: forward
								? t("Write your email")
								: t("Write your reply"),
						disabled: ui.busy,
						"data-focus-key": "reply-text",
						"data-scroll-key": "reply-text",
						oninput: (event: Event) => {
							const field = event.target as HTMLTextAreaElement;
							reply.text = field.value;
							edited(reply, field);
						},
					},
					reply.text,
				),
			),
			reply.error ? h("p", { class: "mailbox-write-error", role: "alert" }, reply.error) : null,
			h(
				"div",
				{ class: "mailbox-write-foot" },
				h(
					"button",
					{ type: "submit", class: "mailbox-primary", disabled: ui.busy, "data-focus-key": "reply-send" },
					chosen ? t("Ask {name} to write it", { name: chosen.displayName }) : ui.busy ? t("Sending") : t("Send"),
				),
				// Beside it: who sends it, and from which of the company's addresses.
				chosen
					? h("span", { class: "mailbox-muted" }, t("{name} writes and sends it", { name: chosen.displayName }))
					: from
						? h(
								"span",
								{ class: "mailbox-muted" },
								h("span", { class: "mailbox-from-address" }, t("from {address}", { address: from })),
							)
						: null,
				h(
					"button",
					{
						type: "button",
						class: "mailbox-icon mailbox-reply-discard",
						title: t("Discard"),
						"aria-label": t("Discard"),
						disabled: ui.busy,
						onclick: () => {
							drop();
							page.redraw(`answer:${reply.kind}`);
						},
					},
					icon("trash"),
				),
			),
		),
	);
}
