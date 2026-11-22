import type { HostedProfileMember, HostedStaffAgent } from "../../cloud/types.ts";
import type { WorksFor, WorksForAsk, WorksForLogin } from "../../cloud/works-for.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { boardDrag } from "../../ui/board-drag.ts";
import { type MenuEntry, openContextMenu } from "../../ui/context-menu.ts";
import { h, icon, personAvatar, personColor, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
import type { CompanyController } from "../company.ts";

/* The Members page (Jonas, 9 November 2026: "this interface should help clear up and delegate responsibility/ownership
 * between members ... through simple and big visuals"; 10 November: "dont want any textbased sections, pure visual",
 * "you can get rid of the containers too" and, of the bar with the page's title, "get rid of the pages header though,
 * it's pointless"). Each agent but the Co-Founder works for one member, whose ChatGPT runs the work handed to it
 * (migrations 20260930700000 and 20260930701000). The page is pictures only, with no header, no text and no boxes: a
 * line per member, their face, name and ChatGPT meter, then the figures of the agents that work for them, by name
 * only ("get rid of the subtitles for the agents"). An agent moves by a drag onto another member's line, or by a tap
 * and a choice from a menu; until the other side says yes it stands faded where it would go. The Co-Founder stands by
 * everyone's faces, and agents nobody works for have a last line of their own. What a picture means in words is its
 * tooltip. */

/** How often the page reads again while it is open. */
const READ_EVERY_MS = 30_000;
/** Up to this many members the agents are drawn big; with more, smaller. */
const ROOMY_UP_TO = 3;

export interface MembersOptions {
	/** Opens Settings at a tab, for Connect ChatGPT and Sign in again. */
	readonly openSettings?: (tab: "ai-subscriptions") => void;
}

interface Page {
	readonly company: CompanyController;
	options: MembersOptions;
	data: WorksFor | undefined;
	error: string | undefined;
	/** A call on its way; the page waits for it. */
	busy: boolean;
	/** Why the last call failed. What a call did, the page shows by itself. */
	note: string | undefined;
	readSeq: number;
	stop: (() => void) | undefined;
}

interface Seat {
	/** The member's account, or "" for the agents nobody works for. */
	readonly id: string;
	readonly member: HostedProfileMember | null;
	readonly name: string;
	readonly you: boolean;
	readonly colour: string;
	readonly login: WorksForLogin | undefined;
	readonly agents: readonly HostedStaffAgent[];
}

interface Ctx {
	readonly container: HTMLElement;
	readonly page: Page;
	readonly company: CompanyController;
	readonly data: WorksFor;
	readonly seats: readonly Seat[];
	/** The company's agents that still work here, by id. */
	readonly staff: ReadonlyMap<string, HostedStaffAgent>;
	readonly cofounder: HostedStaffAgent | undefined;
	readonly agentName: (id: string) => string;
	readonly memberName: (id: string | null) => string;
	readonly viewer: string;
}

const pages = new WeakMap<HTMLElement, Page>();
const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** When a full login resets, short enough for a line: the weekday and time within a week, else the date. */
function resetTime(iso: string): string {
	const at = new Date(iso);
	const soon = at.getTime() - Date.now() < 6 * 24 * 3600 * 1000;
	return new Intl.DateTimeFormat(
		presentationLocale(),
		soon ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" },
	).format(at);
}

export function renderMembers(container: HTMLElement, company: CompanyController, options: MembersOptions = {}): void {
	let page = pages.get(container);
	if (!page || page.company !== company) {
		page?.stop?.();
		const fresh: Page = {
			company,
			options,
			data: undefined,
			error: undefined,
			busy: false,
			note: undefined,
			readSeq: 0,
			stop: undefined,
		};
		pages.set(container, fresh);
		void read(container, fresh);
		const stop = () => {
			clearInterval(timer);
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
			company.signal.removeEventListener("abort", stop);
			if (pages.get(container) === fresh) pages.delete(container);
		};
		// WHY: Skip hidden background polls and refresh on tab return without leaking listeners after view unmount.
		const onVisible = () => {
			if (!showing(container, fresh) || company.signal.aborted) {
				stop();
				return;
			}
			if (!document.hidden) void read(container, fresh);
		};
		const timer = setInterval(() => {
			// The page ends when another view took its container (the app reuses it), the container left the document or
			// the company stopped; coming back draws a new one.
			if (!showing(container, fresh) || company.signal.aborted) {
				stop();
				return;
			}
			if (typeof document !== "undefined" && document.hidden) return;
			void read(container, fresh);
		}, READ_EVERY_MS);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
		company.signal.addEventListener("abort", stop, { once: true });
		fresh.stop = stop;
		page = fresh;
	}
	page.options = options;
	draw(container, page);
}

/** Each company's last read, for the Leave company dialog (views/team.ts). */
const lastRead = new WeakMap<CompanyController, WorksFor>();

/** How many agents work for the member, as the Members page last read it; undefined when it never read. */
export function worksForCount(company: CompanyController): number | undefined {
	return lastRead.get(company)?.agents.filter((agent) => agent.userId === company.userId).length;
}

/** Whether the container still shows this page: its own section is the container's, and nothing else took it. */
function showing(container: HTMLElement, page: Page): boolean {
	return (
		pages.get(container) === page &&
		container.isConnected &&
		drawn.get(container)?.element === container.firstElementChild
	);
}

async function read(container: HTMLElement, page: Page): Promise<void> {
	const seq = ++page.readSeq;
	try {
		const data = await page.company.worksFor().read();
		if (seq !== page.readSeq) return;
		page.data = data;
		lastRead.set(page.company, page.data);
		page.error = undefined;
	} catch (error) {
		if (seq !== page.readSeq) return;
		page.error = error instanceof Error ? error.message : String(error);
	}
	// An answer that comes after the member went to another view draws nothing over it.
	if (showing(container, page)) draw(container, page);
}

/** Runs a call, then reads again: the page shows what it did. Why it failed, when it did, stands at the top. */
async function act(container: HTMLElement, page: Page, call: () => Promise<unknown>): Promise<void> {
	if (page.busy) return;
	page.busy = true;
	page.note = undefined;
	draw(container, page);
	try {
		await call();
	} catch (error) {
		page.note = error instanceof Error ? error.message : String(error);
	}
	page.busy = false;
	await read(container, page);
}

/** What the page was last drawn from, so a redraw of the company that changes none of it leaves the page (its scroll
 * and focus) alone. */
const drawn = new WeakMap<HTMLElement, { key: string; element: Element }>();

function draw(container: HTMLElement, page: Page): void {
	const { company } = page;
	const state = company.store.get();
	const key = JSON.stringify([
		presentationLocale(),
		state.team?.members,
		state.staff.map((agent) => [agent.id, agent.displayName, agent.employmentStatus, agent.appearance]),
		page.data,
		page.error,
		page.busy,
		page.note,
		Boolean(page.options.openSettings),
	]);
	const last = drawn.get(container);
	if (last?.key === key && container.firstElementChild === last.element) return;
	const shell = (...body: (HTMLElement | null)[]) => {
		const element = h(
			"section",
			{ class: "interface members", "data-interface": "members" },
			// No header (Jonas: "it's pointless"); the name stays for a screen reader.
			h("h1", { class: "visually-hidden" }, t("Members")),
			h("div", { class: "members-page" }, ...body),
		);
		replace(container, element);
		drawn.set(container, { key, element });
	};
	const data = page.data;
	if (!data) {
		shell(h("p", { class: "members-foot" }, page.error ?? t("Reading who each agent works for…")));
		return;
	}
	const viewer = company.userId;
	// A viewer takes no agents, but one whose agents still work for them (made a viewer later) keeps their line.
	const members = [...(state.team?.members ?? [])]
		.filter((member) => member.role !== "viewer" || data.agents.some((agent) => agent.userId === member.userId))
		.sort(
			(a, b) => Number(b.userId === viewer) - Number(a.userId === viewer) || a.joinedAt.localeCompare(b.joinedAt),
		);
	const staff = new Map(
		state.staff.filter((agent) => agent.employmentStatus === "active").map((agent) => [agent.id, agent]),
	);
	const agentsOf = (userId: string | null) =>
		data.agents
			.filter((entry) => entry.userId === userId)
			.flatMap((entry) => staff.get(entry.agentId) ?? [])
			.sort((a, b) => a.displayName.localeCompare(b.displayName));
	const seats: Seat[] = members.map((member) => ({
		id: member.userId,
		member,
		name: member.displayName || member.email,
		you: member.userId === viewer,
		colour: personColor(member.userId),
		login: data.logins.find((login) => login.userId === member.userId),
		agents: agentsOf(member.userId),
	}));
	const nobody: Seat = {
		id: "",
		member: null,
		name: t("Nobody"),
		you: false,
		colour: "var(--text-soft)",
		login: undefined,
		agents: agentsOf(null),
	};
	const cofounder = [...staff.values()].find((agent) => agent.templateId === "co-founder");
	const ctx: Ctx = {
		container,
		page,
		company,
		data,
		seats,
		staff,
		cofounder,
		agentName: (id) => staff.get(id)?.displayName ?? t("an agent"),
		memberName: (id) => {
			if (id === null) return t("nobody");
			if (id === viewer) return t("you");
			const member = state.team?.members.find((candidate) => candidate.userId === id);
			return member ? firstName(member.displayName || member.email) : t("someone who left");
		},
		viewer,
	};
	const roomy = seats.length <= ROOMY_UP_TO;
	const size = roomy ? 72 : 40;
	shell(
		page.note ? h("p", { class: "members-note", role: "alert" }, page.note) : null,
		h(
			"div",
			{ class: `members-rows${roomy ? "" : " is-compact"}` },
			...seats.map((seat) => row(ctx, seat, size)),
			// The Co-Founder works for every member: it stands by all their faces, and stays there.
			cofounder
				? h(
						"div",
						{
							class: "members-row is-everyone",
							role: "group",
							"aria-label": t("The Co-Founder works for everyone."),
						},
						h(
							"div",
							{ class: "members-who" },
							h(
								"span",
								{ class: "members-faces", "aria-hidden": "true" },
								...seats.slice(0, 3).map((seat) => personAvatar(seat.name, seat.id)),
							),
							h("div", { class: "members-who-text" }, h("b", null, t("Everyone"))),
						),
						h(
							"div",
							{ class: "members-crew" },
							h(
								"div",
								{ class: "members-tile" },
								h(
									"button",
									{
										class: "members-agent",
										type: "button",
										disabled: true,
										title: t("The Co-Founder works for everyone."),
									},
									...stand(cofounder, size),
								),
							),
						),
					)
				: null,
			nobody.agents.length ? row(ctx, nobody, size) : null,
		),
	);
}

/** What an agent's button holds: its figure with whatever marks it, and its name. */
function stand(agent: HostedStaffAgent, size: number, mark?: HTMLElement): HTMLElement[] {
	return [
		h("span", { class: "members-pic" }, agentFigure(agent, "", { size, still: true }), mark ?? null),
		h("span", { class: "members-agent-name" }, agent.displayName),
	];
}

/** What an ask says to the member who answers it. */
function askText(ctx: Ctx, pending: WorksForAsk): string {
	const fromAgent = !pending.askedByUserId && pending.askedByAgentId ? ctx.agentName(pending.askedByAgentId) : null;
	const asker = pending.askedByUserId
		? ctx.memberName(pending.askedByUserId)
		: fromAgent
			? pending.askedByAgentId === ctx.cofounder?.id
				? t("{agent}, your Co-Founder,", { agent: fromAgent })
				: fromAgent
			: t("someone who left");
	const agent = ctx.agentName(pending.agentId);
	const says =
		pending.toUserId === ctx.viewer
			? t("{asker} asks you to take {agent}. Your ChatGPT then carries the work handed to {agent}.", {
					asker,
					agent,
				})
			: t("{asker} asks to take {agent} from you.", { asker, agent });
	return pending.why ? `${says} “${pending.why}”` : says;
}

/** Whether the viewer may ask for an agent of `from` to go to `to`. */
function sendable(ctx: Ctx, from: string | null, to: string): boolean {
	if (!ctx.data.mayAsk || from === to) return false;
	if (ctx.seats.find((seat) => seat.id === to)?.member?.role === "viewer") return false;
	return ctx.data.mayAskForOthers || to === ctx.viewer || from === ctx.viewer;
}

/** A member's line: their face, name and ChatGPT, then the agents that work for them and the ones on their way here.
 * Another member's agent can be dropped on it. */
function row(ctx: Ctx, seat: Seat, size: number): HTMLElement {
	const member = firstName(seat.name);
	const n = String(seat.agents.length);
	const face = seat.member
		? personAvatar(seat.name, seat.member.userId)
		: h("span", { class: "members-nobody-face", "aria-hidden": "true" }, "?");
	face.classList.add("members-face");
	const one = seat.agents.length === 1;
	// The line in words, for a screen reader: the figures say it to the eye.
	const count = seat.you
		? one
			? t("1 agent works for you")
			: t("{n} agents work for you", { n })
		: seat.member
			? one
				? t("1 agent works for {member}", { member })
				: t("{n} agents work for {member}", { n, member })
			: one
				? t("1 agent")
				: t("{n} agents", { n });
	const stuck = seat.agents.length > 0 && (seat.login?.state === "full" || seat.login?.state === "sign_in");
	const coming = seat.member
		? ctx.data.asks.flatMap((pending) => {
				const agent = pending.toUserId === seat.id ? ctx.staff.get(pending.agentId) : undefined;
				return agent ? [agent] : [];
			})
		: [];
	const empty = !seat.agents.length && !coming.length;
	const element = h(
		"div",
		{
			class: `members-row${stuck ? " is-stuck" : ""}${empty ? " is-empty" : ""}`,
			role: "group",
			"aria-label": count,
			...(seat.member ? { "data-drop-lane": seat.id } : {}),
		},
		h(
			"div",
			{ class: "members-who" },
			face,
			h(
				"div",
				{ class: "members-who-text" },
				h("b", null, seat.you ? t("{name} (you)", { name: member }) : seat.name),
				seat.member ? subscription(ctx, seat) : null,
			),
		),
		h(
			"div",
			{ class: "members-crew" },
			...seat.agents.map((agent) => tile(ctx, seat, agent, size, false)),
			...coming.map((agent) => tile(ctx, seat, agent, size, true)),
			// An empty place: all an empty line shows, and where a dragged agent lands.
			seat.member
				? h(
						"span",
						{
							class: "members-slot",
							...(empty
								? {
										title: seat.you
											? t("No agents work for you yet.")
											: t("No agents work for {member} yet.", { member }),
									}
								: { "aria-hidden": "true" }),
						},
						h("i"),
					)
				: null,
		),
	);
	element.style.setProperty("--seat", seat.colour);
	return element;
}

/** A member's ChatGPT as a picture: its mark and a meter of how much of the usage window is used. A full one is amber
 * and says when it has room again; one that is not there, or needs a new sign-in, is a broken line. */
function subscription(ctx: Ctx, seat: Seat): HTMLElement {
	const login = seat.login;
	const openSettings = ctx.page.options.openSettings;
	const settings = (label: string) =>
		seat.you && openSettings
			? [
					h(
						"button",
						{ class: "btn btn-small", type: "button", onclick: () => openSettings("ai-subscriptions") },
						label,
					),
				]
			: null;
	const mark = h("img", { class: "members-gpt", src: "./assets/provider-openai.svg", alt: "" });
	const meter = (used: number) => {
		const fill = h("i");
		fill.style.width = `${Math.max(4, used)}%`;
		return h("span", { class: "members-meter" }, used ? fill : null);
	};
	if (!login || login.state === "none")
		return h(
			"div",
			{
				class: "members-sub is-none",
				title: seat.you ? t("You have not connected ChatGPT.") : t("No ChatGPT connected"),
			},
			...(settings(t("Connect ChatGPT")) ?? [mark, meter(0)]),
		);
	if (login.state === "sign_in")
		return h(
			"div",
			{ class: "members-sub is-out", title: t("Needs a new sign-in.") },
			...(settings(t("Sign in again")) ?? [mark, meter(0)]),
		);
	if (login.state === "full")
		return h(
			"div",
			{
				class: "members-sub is-warn",
				title: login.resetsAt ? t("Full until {time}.", { time: resetTime(login.resetsAt) }) : t("Full for now."),
			},
			mark,
			meter(100),
			login.resetsAt ? h("span", null, resetTime(login.resetsAt)) : null,
		);
	const used = login.usedPercent;
	return h(
		"div",
		{
			class: "members-sub",
			title: `${t("ChatGPT")}: ${used === null ? t("Connected") : t("{n} % used", { n: String(used) })}`,
		},
		mark,
		...(used === null ? [icon("check")] : [meter(used), h("span", null, `${used} %`)]),
	);
}

/** What a tap on an agent with an open ask offers: yes or no to the member who answers, take back to the one who
 * asked. */
function pendingItems(ctx: Ctx, pending: WorksForAsk): MenuEntry[] {
	const { container, page, viewer } = ctx;
	const say = (yes: boolean) => () => void act(container, page, () => ctx.company.worksFor().answer(pending.id, yes));
	if (pending.answerByUserId === viewer)
		return [
			{ kind: "caption", label: askText(ctx, pending) },
			{ label: t("Yes"), icon: "check", select: say(true) },
			{ label: t("No"), icon: "close", select: say(false) },
		];
	if (pending.askedByUserId === viewer)
		return [
			{ kind: "caption", label: t("Waiting for {member}", { member: ctx.memberName(pending.answerByUserId) }) },
			{ label: t("Take back"), icon: "back", select: say(false) },
		];
	return [];
}

/** An agent in a member's line: its figure and name. A tap opens where it can go; a drag onto another member's line
 * asks for the move. While an ask is open the agent stands twice: where it works, with the face of the member it would
 * go to on its figure, and faded in that member's line (`coming`). The member who answers has yes and no under the one
 * in their own line. */
function tile(ctx: Ctx, seat: Seat, agent: HostedStaffAgent, size: number, coming: boolean): HTMLElement {
	const { container, page, viewer } = ctx;
	const holder = seat.member ? seat.id : null;
	const pending = ctx.data.asks.find((entry) => entry.agentId === agent.id);
	const targets = pending || coming ? [] : ctx.seats.filter((to) => sendable(ctx, holder, to.id));
	const items = (): MenuEntry[] => {
		if (pending) return pendingItems(ctx, pending);
		if (!targets.length) return [];
		return [
			{
				kind: "caption",
				label:
					holder === viewer
						? t("{agent} works for you", { agent: agent.displayName })
						: t("{agent} works for {member}", { agent: agent.displayName, member: ctx.memberName(holder) }),
			},
			...targets.map((to): MenuEntry => {
				const member = firstName(to.name);
				// Taking an agent asks the member it works for; offering one asks the member it would go to.
				const says = to.you ? holder : to.id;
				const hints = [
					says === null ? null : t("{member} says yes first.", { member: ctx.memberName(says) }),
					!to.login || to.login.state === "none"
						? to.you
							? t("You have not connected ChatGPT.")
							: t("{member} has no ChatGPT yet.", { member })
						: null,
				].filter((hint) => hint !== null);
				return {
					label: to.you ? t("Move to me") : t("Move to {member}", { member }),
					lead: personAvatar(to.name, to.id),
					...(hints.length ? { hint: hints.join(" ") } : {}),
					select: () => void act(container, page, () => ctx.company.worksFor().ask(agent.id, to.id)),
				};
			}),
		];
	};
	const live = !page.busy && items().length > 0;
	const goes = pending && !coming ? ctx.seats.find((to) => to.id === pending.toUserId) : undefined;
	const waits = pending
		? pending.answerByUserId === viewer
			? t("Waiting for you")
			: t("Waiting for {member}", { member: ctx.memberName(pending.answerByUserId) })
		: null;
	// The button the page finds again after it drew itself anew: the agent where it works, or where it would go.
	const found = coming ? "data-coming" : "data-agent";
	const button = h(
		"button",
		{
			class: `members-agent${coming ? " is-coming" : ""}`,
			type: "button",
			[found]: agent.id,
			...(waits ? { title: waits } : {}),
			disabled: !live,
			...(live ? { "aria-haspopup": "menu" } : {}),
		},
		...stand(
			agent,
			size,
			goes ? h("span", { class: "members-to", "aria-hidden": "true" }, personAvatar(goes.name, goes.id)) : undefined,
		),
	);
	// Yes and no stand in the line of the member who answers: by the faded agent when it would come to them, by the
	// agent itself when it would leave them.
	const answers =
		pending && pending.answerByUserId === viewer && coming === (pending.toUserId === viewer)
			? h(
					"span",
					{ class: "members-answer" },
					...([true, false] as const).map((yes) =>
						h(
							"button",
							{
								class: yes ? "is-yes" : "",
								type: "button",
								title: yes ? t("Yes") : t("No"),
								"aria-label": yes ? t("Yes") : t("No"),
								disabled: page.busy,
								onclick: () => void act(container, page, () => ctx.company.worksFor().answer(pending.id, yes)),
							},
							icon(yes ? "check" : "close"),
						),
					),
				)
			: null;
	const element = h("div", { class: "members-tile" }, button, answers);
	if (!live) return element;
	// A press on the agent while its menu is open only closes the menu: the menu says which press closed it, and the
	// click that press ends in opens nothing. A click from the keyboard has no press before it.
	let closedBy: Event | undefined;
	let closes = false;
	button.addEventListener("pointerdown", (event) => {
		closes = event === closedBy;
	});
	button.addEventListener("click", (event) => {
		const closing = closes && event.detail > 0;
		closes = false;
		if (closing) return;
		const rect = button.getBoundingClientRect();
		openContextMenu({
			label: agent.displayName,
			x: rect.left,
			y: rect.bottom + 4 * uiScale(),
			items: items(),
			opener: button,
			findOpener: () => container.querySelector<HTMLElement>(`.members-agent[${found}="${agent.id}"]`),
			onClose: (press) => {
				closedBy = press;
			},
		});
	});
	boardDrag(button, {
		within: ".members-page",
		targets: targets.map((to) => to.id),
		drop: (to) => void act(container, page, () => ctx.company.worksFor().ask(agent.id, to)),
	});
	return element;
}
