import type { HostedProfileMember, HostedStaffAgent } from "../../cloud/types.ts";
import type { WorksFor, WorksForAsk, WorksForLogin } from "../../cloud/works-for.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, personAvatar, personColor, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { agentList } from "../interface-areas.ts";
import { interfaceRows } from "../interfaces.ts";

/* The Members page (Jonas, 9 November 2026: "this interface should help clear up and delegate responsibility/ownership
 * between members, help you re-organize supervision and subscription commitments etc through simple and big visuals").
 * Each agent but the Co-Founder works for one member, whose subscription carries its own work (migrations
 * 20260930700000 and 20260930701000). Up to three members the page draws a mat per member, side by side; with more, every
 * member as a small tile and one of them opened big below (Jonas: "not sure how any of them scales ... let's say there
 * were 10"). An agent moves by an ask the other side says yes to; an agent nobody works for sits in the open pile. */

/** How often the page reads again while it is open. */
const READ_EVERY_MS = 30_000;
/** Above this many members, the overview: a tile each and one member open. */
const MATS_UP_TO = 3;

interface Page {
	readonly company: CompanyController;
	data: WorksFor | undefined;
	error: string | undefined;
	/** An agent picked to move. */
	picked: string | undefined;
	/** The member open below the overview. */
	open: string | undefined;
	/** A call on its way; the page waits for it. */
	busy: boolean;
	/** What the last call did, or why it failed. */
	note: string | undefined;
	dismissed: boolean;
	timer: ReturnType<typeof setInterval> | undefined;
}

interface Seat {
	readonly id: string;
	readonly member: HostedProfileMember | null;
	readonly name: string;
	readonly you: boolean;
	readonly colour: string;
	readonly login: WorksForLogin | undefined;
	readonly agents: readonly HostedStaffAgent[];
}

interface Ctx {
	readonly page: Page;
	readonly company: CompanyController;
	readonly data: WorksFor;
	readonly seats: readonly Seat[];
	readonly cofounder: HostedStaffAgent | undefined;
	readonly areaOf: (agent: HostedStaffAgent) => string;
	readonly agentName: (id: string) => string;
	readonly memberName: (id: string | null) => string;
	readonly viewer: string;
	readonly redraw: () => void;
}

const pages = new WeakMap<HTMLElement, Page>();
const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** When a full login resets, short enough for a tile: the weekday and time within a week, else the date. */
function resetTime(iso: string): string {
	const at = new Date(iso);
	const soon = at.getTime() - Date.now() < 6 * 24 * 3600 * 1000;
	return new Intl.DateTimeFormat(
		presentationLocale(),
		soon ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" },
	).format(at);
}

export function renderMembers(container: HTMLElement, company: CompanyController): void {
	let page = pages.get(container);
	if (!page || page.company !== company) {
		if (page?.timer) clearInterval(page.timer);
		const fresh: Page = {
			company,
			data: undefined,
			error: undefined,
			picked: undefined,
			open: undefined,
			busy: false,
			note: undefined,
			dismissed: false,
			timer: undefined,
		};
		pages.set(container, fresh);
		void read(container, fresh);
		fresh.timer = setInterval(() => {
			if (!container.isConnected || pages.get(container) !== fresh || company.signal.aborted) {
				clearInterval(fresh.timer);
				return;
			}
			void read(container, fresh);
		}, READ_EVERY_MS);
		page = fresh;
	}
	draw(container, page);
}

async function read(container: HTMLElement, page: Page): Promise<void> {
	try {
		page.data = await page.company.worksFor().read();
		page.error = undefined;
	} catch (error) {
		page.error = error instanceof Error ? error.message : String(error);
	}
	if (pages.get(container) === page && container.isConnected) draw(container, page);
}

/** Runs a call, then reads again; what it did, or why it failed, shows at the top of the page. */
async function act(container: HTMLElement, page: Page, call: () => Promise<string>): Promise<void> {
	if (page.busy) return;
	page.busy = true;
	page.picked = undefined;
	draw(container, page);
	try {
		page.note = await call();
	} catch (error) {
		page.note = error instanceof Error ? error.message : String(error);
	}
	page.busy = false;
	await read(container, page);
}

function draw(container: HTMLElement, page: Page): void {
	const { company } = page;
	const state = company.store.get();
	const head = h(
		"header",
		{ class: "interface-head" },
		interfaceEmblem("members", 30),
		h(
			"div",
			{ class: "interface-title" },
			h("h1", null, t("Members")),
			h("small", null, t("Who each agent works for.")),
		),
	);
	const shell = (...body: (HTMLElement | null)[]) =>
		replace(
			container,
			h(
				"section",
				{ class: "interface members", "data-interface": "members" },
				head,
				h("div", { class: "members-page" }, ...body),
			),
		);
	const data = page.data;
	if (!data) {
		shell(h("p", { class: "members-foot" }, page.error ?? t("Reading who each agent works for…")));
		return;
	}
	const viewer = company.userId;
	const members = [...(state.team?.members ?? [])]
		.filter((member) => member.role !== "viewer")
		.sort(
			(a, b) => Number(b.userId === viewer) - Number(a.userId === viewer) || a.joinedAt.localeCompare(b.joinedAt),
		);
	const staff = new Map(state.staff.map((agent) => [agent.id, agent]));
	const agentsOf = (userId: string | null) =>
		data.agents
			.filter((entry) => entry.userId === userId)
			.flatMap((entry) => {
				const agent = staff.get(entry.agentId);
				return agent && agent.employmentStatus === "active" ? [agent] : [];
			})
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
	const pile: Seat = {
		id: "",
		member: null,
		name: t("Open pile"),
		you: false,
		colour: "var(--text-soft)",
		login: undefined,
		agents: agentsOf(null),
	};
	// An agent's area: the row of the areas table whose agents cell holds it, else its role.
	const areas = new Map<string, string>();
	for (const item of interfaceRows(company, "table:areas") ?? []) {
		const name = item.row.area;
		if (typeof name === "string") for (const id of agentList(item.row.agents)) areas.set(id, name);
	}
	const memberName = (id: string | null) => {
		if (id === null) return t("nobody");
		if (id === viewer) return t("you");
		const member = state.team?.members.find((candidate) => candidate.userId === id);
		return member ? firstName(member.displayName || member.email) : t("someone who left");
	};
	const ctx: Ctx = {
		page,
		company,
		data,
		seats,
		cofounder: state.staff.find((agent) => agent.templateId === "co-founder" && agent.employmentStatus === "active"),
		areaOf: (agent) => areas.get(agent.id) ?? agent.role,
		agentName: (id) => staff.get(id)?.displayName ?? t("an agent"),
		memberName,
		viewer,
		redraw: () => draw(container, page),
	};
	const many = seats.length > MATS_UP_TO;
	shell(
		page.note ? h("p", { class: "members-note", role: "status" }, page.note) : null,
		asksForYou(container, ctx),
		suggestion(container, ctx),
		many ? null : split(ctx, pile),
		many ? overview(container, ctx) : mats(container, ctx),
		pile.agents.length ? mat(container, ctx, pile) : null,
		h(
			"p",
			{ class: "members-foot" },
			t("Work already running finishes on the login it started on. Only new work moves."),
		),
	);
}

/** The asks the viewer answers: yes or no. */
function asksForYou(container: HTMLElement, ctx: Ctx): HTMLElement | null {
	const mine = ctx.data.asks.filter((entry) => entry.answerByUserId === ctx.viewer);
	if (!mine.length) return null;
	return h(
		"div",
		{ class: "members-asks" },
		...mine.map((pending) => {
			const asker = pending.askedByUserId
				? ctx.memberName(pending.askedByUserId)
				: ctx.agentName(pending.askedByAgentId ?? "");
			const agent = ctx.agentName(pending.agentId);
			const text =
				pending.toUserId === ctx.viewer
					? t("{asker} asks you to take {agent}. Your ChatGPT then carries {agent}'s own work.", { asker, agent })
					: t("{asker} asks to take {agent} from you.", { asker, agent });
			const found = ctx.company.store.get().staff.find((candidate) => candidate.id === pending.agentId);
			return h(
				"div",
				{ class: "members-ask" },
				found ? agentFigure(found, "", { size: 40, still: true }) : null,
				h("p", null, text),
				h(
					"button",
					{
						class: "btn btn-primary btn-small",
						type: "button",
						disabled: ctx.page.busy,
						onclick: () => void act(container, ctx.page, () => answer(ctx, pending, true)),
					},
					t("Yes"),
				),
				h(
					"button",
					{
						class: "btn btn-small",
						type: "button",
						disabled: ctx.page.busy,
						onclick: () => void act(container, ctx.page, () => answer(ctx, pending, false)),
					},
					t("No"),
				),
			);
		}),
	);
}

async function answer(ctx: Ctx, pending: WorksForAsk, yes: boolean): Promise<string> {
	const result = await ctx.company.worksFor().answer(pending.id, yes);
	const agent = ctx.agentName(pending.agentId);
	if (result.status === "yes")
		return t("{agent} now works for {member}.", { agent, member: ctx.memberName(pending.toUserId) });
	if (result.status === "void") return t("{agent} moved meanwhile, so nothing changed.", { agent });
	if (result.status === "withdrawn") return t("You took back the ask about {agent}.", { agent });
	return t("{agent} stays where it is.", { agent });
}

/** Asks for each agent to work for the member, one after the other. */
async function ask(ctx: Ctx, agents: readonly string[], to: string): Promise<string> {
	let moved = 0;
	for (const id of agents) if ((await ctx.company.worksFor().ask(id, to)).moved) moved++;
	const member = ctx.memberName(to);
	const one = agents.length === 1 ? ctx.agentName(agents[0] ?? "") : undefined;
	if (moved === agents.length)
		return one
			? t("{agent} now works for {member}.", { agent: one, member })
			: t("{n} agents now work for {member}.", { n: String(agents.length), member });
	if (to === ctx.viewer) {
		const holder = ctx.data.agents.find((entry) => entry.agentId === agents[0])?.userId ?? null;
		return t("Asked {member}. You take over when they say yes.", { member: ctx.memberName(holder) });
	}
	return t("Asked {member}. Nothing moves until they say yes.", { member });
}

/** A suggestion when a member's agents can't work right now, or one member carries the crew and another none. */
function suggestion(container: HTMLElement, ctx: Ctx): HTMLElement | null {
	const { seats, page, data } = ctx;
	if (page.dismissed || !data.mayAsk || seats.length < 2) return null;
	const open = new Set(data.asks.map((entry) => entry.agentId));
	const stuck = seats.find(
		(seat) =>
			(seat.login?.state === "full" || seat.login?.state === "sign_in") &&
			seat.agents.some((agent) => !open.has(agent.id)),
	);
	const roomiest = [...seats]
		.filter((seat) => seat !== stuck && seat.login?.state === "ready")
		.sort(
			(a, b) => (a.login?.usedPercent ?? 50) - (b.login?.usedPercent ?? 50) || a.agents.length - b.agents.length,
		)[0];
	let text: string | undefined;
	let agents: string[] = [];
	let to: Seat | undefined;
	if (stuck && roomiest) {
		agents = stuck.agents.filter((agent) => !open.has(agent.id)).map((agent) => agent.id);
		to = roomiest;
		const names = stuck.agents.map((agent) => agent.displayName).join(", ");
		const member = stuck.you ? t("You") : firstName(stuck.name);
		const other = roomiest.you ? t("you") : firstName(roomiest.name);
		text =
			stuck.login?.state === "full"
				? stuck.login.resetsAt
					? t("{member}: ChatGPT is full until {time}, so {agents} wait. Shall {other} take them for now?", {
							member,
							time: resetTime(stuck.login.resetsAt),
							agents: names,
							other,
						})
					: t("{member}: ChatGPT is full, so {agents} wait. Shall {other} take them for now?", {
							member,
							agents: names,
							other,
						})
				: t("{member}: ChatGPT needs a new sign-in, so {agents} wait. Shall {other} take them for now?", {
						member,
						agents: names,
						other,
					});
	} else {
		const top = [...seats].sort((a, b) => b.agents.length - a.agents.length)[0];
		const empty = seats.find((seat) => !seat.agents.length && seat.login?.state === "ready");
		if (!top || !empty || top.agents.length < 3) return null;
		const byArea = new Map<string, HostedStaffAgent[]>();
		for (const agent of top.agents) {
			if (open.has(agent.id)) continue;
			byArea.set(ctx.areaOf(agent), [...(byArea.get(ctx.areaOf(agent)) ?? []), agent]);
		}
		const [area, group] = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
		if (!area || !group || group.length >= top.agents.length) return null;
		agents = group.map((agent) => agent.id);
		to = empty;
		const other = empty.you ? t("you") : firstName(empty.name);
		const n = String(top.agents.length);
		text = top.you
			? t("You carry {n} agents and {other} none. Shall {other} take {area}?", { n, other, area })
			: t("{member} carries {n} agents and {other} none. Shall {other} take {area}?", {
					member: firstName(top.name),
					n,
					other,
					area,
				});
	}
	if (!to || !agents.length || !text) return null;
	// Only the member they work for, the member they would go to, or an owner or admin may ask.
	const target = to;
	const from = agents.map((id) => data.agents.find((entry) => entry.agentId === id)?.userId ?? null);
	if (!from.every((holder) => sendable(ctx, holder, target.id))) return null;
	return h(
		"div",
		{ class: "members-suggest" },
		ctx.cofounder ? agentFigure(ctx.cofounder, "", { size: 44, still: true }) : null,
		h("p", null, h("b", null, t("Suggestion")), " ", text),
		h(
			"button",
			{
				class: "btn btn-primary btn-small",
				type: "button",
				disabled: page.busy,
				onclick: () => void act(container, page, () => ask(ctx, agents, target.id)),
			},
			target.you ? t("Take them") : t("Ask {member}", { member: firstName(target.name) }),
		),
		h(
			"button",
			{
				class: "btn btn-small",
				type: "button",
				onclick: () => {
					page.dismissed = true;
					ctx.redraw();
				},
			},
			t("Not now"),
		),
	);
}

/** The split: one bar in the members' colours, with what each carries. */
function split(ctx: Ctx, pile: Seat): HTMLElement {
	const all = [...ctx.seats, ...(pile.agents.length ? [pile] : [])];
	return h(
		"div",
		{ class: "members-split" },
		h(
			"div",
			{ class: "members-split-bar", "aria-hidden": "true" },
			...all.map((seat) => {
				const part = h("i");
				part.style.flexGrow = String(seat.agents.length);
				part.style.background = seat.colour;
				return part;
			}),
		),
		h(
			"p",
			{ class: "members-split-legend" },
			...all.map((seat) =>
				h(
					"span",
					null,
					h("i", { style: `background:${seat.colour}` }),
					h("b", null, seat.you ? t("You") : seat.member ? firstName(seat.name) : seat.name),
					` ${seat.agents.length} / ${ctx.data.agents.length}`,
				),
			),
		),
	);
}

/** A member's subscription: how much of the usage window is used, and what is wrong when something is. */
function subscription(seat: Seat): HTMLElement {
	const login = seat.login;
	if (!login || login.state === "none")
		return h("div", { class: "members-sub is-none" }, h("span", null, t("No ChatGPT connected")));
	const used = login.state === "full" ? 100 : (login.usedPercent ?? 0);
	const meter = h("span", { class: "members-meter" }, h("i"));
	const fill = meter.firstElementChild as HTMLElement;
	fill.style.width = `${Math.max(2, used)}%`;
	fill.style.background = login.state === "ready" ? seat.colour : "var(--warning)";
	const warn =
		login.state === "sign_in"
			? t("Needs a new sign-in. These agents wait.")
			: login.state === "full"
				? login.resetsAt
					? t("Full until {time}. These agents wait.", { time: resetTime(login.resetsAt) })
					: t("Full for now. These agents wait.")
				: null;
	return h(
		"div",
		{ class: `members-sub${warn ? " is-warn" : ""}` },
		h(
			"span",
			{ class: "members-sub-row" },
			h("span", null, t("ChatGPT")),
			h(
				"b",
				null,
				login.usedPercent === null && login.state === "ready"
					? t("Connected")
					: t("{n} % used", { n: String(used) }),
			),
		),
		meter,
		warn ? h("span", { class: "members-sub-warn" }, warn) : null,
	);
}

/** An agent as a big figure with its name; tapping it picks it to move. */
function agentButton(container: HTMLElement, ctx: Ctx, agent: HostedStaffAgent, size: number): HTMLElement {
	const pending = ctx.data.asks.find((entry) => entry.agentId === agent.id);
	const picked = ctx.page.picked === agent.id;
	const canPick = ctx.data.mayAsk && !pending && !ctx.page.busy;
	return h(
		"div",
		{ class: "members-agent-wrap" },
		h(
			"button",
			{
				class: `members-agent${picked ? " is-picked" : ""}${pending ? " is-asking" : ""}`,
				type: "button",
				title: agent.role,
				disabled: !canPick,
				"aria-pressed": String(picked),
				onclick: () => {
					ctx.page.picked = picked ? undefined : agent.id;
					ctx.redraw();
				},
			},
			agentFigure(agent, "", { size, still: true }),
			h("span", { class: "members-agent-name" }, agent.displayName),
			h("span", { class: "members-agent-role" }, agent.role),
		),
		pending ? pendingLine(container, ctx, pending) : null,
	);
}

function pendingLine(container: HTMLElement, ctx: Ctx, pending: WorksForAsk): HTMLElement {
	return h(
		"span",
		{ class: "members-agent-pending" },
		t("Waiting for {member}", { member: ctx.memberName(pending.answerByUserId) }),
		pending.askedByUserId === ctx.viewer
			? h(
					"button",
					{
						class: "members-link",
						type: "button",
						disabled: ctx.page.busy,
						onclick: () => void act(container, ctx.page, () => answer(ctx, pending, false)),
					},
					t("Take back"),
				)
			: null,
	);
}

/** The agents of one seat, grouped by area side by side. */
function crewByArea(container: HTMLElement, ctx: Ctx, seat: Seat, size: number): HTMLElement {
	const names = [...new Set(seat.agents.map(ctx.areaOf))].sort((a, b) => a.localeCompare(b));
	const groups = names.map((area) =>
		h(
			"div",
			{ class: "members-area" },
			h("span", { class: "members-area-name" }, area),
			h(
				"div",
				{ class: "members-crew" },
				...seat.agents
					.filter((agent) => ctx.areaOf(agent) === area)
					.map((agent) => agentButton(container, ctx, agent, size)),
			),
		),
	);
	if (!seat.agents.length)
		groups.push(
			h(
				"div",
				{ class: "members-empty" },
				h(
					"b",
					null,
					seat.you
						? t("No agents work for you yet.")
						: t("No agents work for {member} yet.", { member: firstName(seat.name) }),
				),
				ctx.data.mayAsk ? h("span", null, t("Tap an agent, then send it here.")) : null,
			),
		);
	return h("div", { class: "members-areas" }, ...groups);
}

function seatHead(seat: Seat, size: number): HTMLElement {
	const face = seat.member
		? personAvatar(seat.name, seat.member.userId)
		: h("span", { class: "members-pile-face", "aria-hidden": "true" }, "?");
	face.classList.add("members-face");
	face.style.setProperty("--face", `${size}px`);
	const n = String(seat.agents.length);
	const member = firstName(seat.name);
	const count = seat.you
		? seat.agents.length === 1
			? t("1 agent works for you")
			: t("{n} agents work for you", { n })
		: seat.agents.length === 1
			? t("1 agent works for {member}", { member })
			: t("{n} agents work for {member}", { n, member });
	return h(
		"div",
		{ class: "members-seat-head" },
		face,
		h(
			"div",
			{ class: "members-who" },
			h("b", null, seat.you ? t("{name} (you)", { name: member }) : seat.name),
			h(
				"span",
				null,
				seat.member ? count : t("These agents work for nobody. Take one, and its own work runs on your ChatGPT."),
			),
		),
	);
}

/** Whether the viewer may ask for an agent of `from` to go to `to`. */
function sendable(ctx: Ctx, from: string | null, to: string): boolean {
	if (!ctx.data.mayAsk || from === to) return false;
	return ctx.data.mayAskForOthers || to === ctx.viewer || from === ctx.viewer;
}

/** Where the picked agent works now (null: nobody), or undefined when nothing is picked. */
function pickedFrom(ctx: Ctx): string | null | undefined {
	const id = ctx.page.picked;
	if (!id) return undefined;
	return ctx.data.agents.find((entry) => entry.agentId === id)?.userId ?? null;
}

/** Where a picked agent can go: a button per member, or (many members) the tiles themselves. */
function moveBar(container: HTMLElement, ctx: Ctx, tapTiles: boolean): HTMLElement | null {
	const id = ctx.page.picked;
	const agent = id ? ctx.company.store.get().staff.find((candidate) => candidate.id === id) : undefined;
	if (!id || !agent) return null;
	const from = pickedFrom(ctx) ?? null;
	return h(
		"div",
		{ class: "members-move" },
		agentFigure(agent, "", { size: 30, still: true }),
		h(
			"span",
			null,
			tapTiles
				? t("Tap who {agent} should work for. They say yes first.", { agent: agent.displayName })
				: t("Move {agent} to", { agent: agent.displayName }),
		),
		...(tapTiles
			? []
			: ctx.seats
					.filter((seat) => sendable(ctx, from, seat.id))
					.map((seat) =>
						h(
							"button",
							{
								class: "btn btn-small members-move-to",
								type: "button",
								style: `--seat:${seat.colour}`,
								onclick: () => void act(container, ctx.page, () => ask(ctx, [id], seat.id)),
							},
							seat.you ? t("You") : firstName(seat.name),
						),
					)),
		h(
			"button",
			{
				class: "btn btn-small members-ghost",
				type: "button",
				onclick: () => {
					ctx.page.picked = undefined;
					ctx.redraw();
				},
			},
			t("Cancel"),
		),
	);
}

function mat(container: HTMLElement, ctx: Ctx, seat: Seat): HTMLElement {
	const from = pickedFrom(ctx);
	const target = from !== undefined && seat.member !== null && sendable(ctx, from, seat.id);
	const element = h(
		"div",
		{ class: `members-mat${seat.you ? " is-you" : ""}${seat.member ? "" : " is-pile"}${target ? " is-target" : ""}` },
		seatHead(seat, 52),
		seat.member ? subscription(seat) : null,
		crewByArea(container, ctx, seat, 64),
	);
	element.style.setProperty("--seat", seat.colour);
	return element;
}

/* Up to three members: a mat each, side by side. */
function mats(container: HTMLElement, ctx: Ctx): HTMLElement {
	return h(
		"div",
		{ class: "members-stage" },
		moveBar(container, ctx, false),
		h("div", { class: "members-mats" }, ...ctx.seats.map((seat) => mat(container, ctx, seat))),
	);
}

/* More members: a tile each (the face in a ring that fills with the usage window, how many agents work for them, their
 * faces, and what is wrong), and one member open big below. You first, then whoever can't work right now, then by how
 * many agents each carries. While an agent is picked, a tap on a tile sends it there. */
function overview(container: HTMLElement, ctx: Ctx): HTMLElement {
	const { page, seats } = ctx;
	const stuck = (seat: Seat) => seat.login?.state === "full" || seat.login?.state === "sign_in";
	const shown = seats.find((seat) => seat.id === page.open) ?? seats.find((seat) => seat.you) ?? seats[0];
	const waiting = seats.filter(stuck);
	const none = seats.filter((seat) => !seat.agents.length);
	const from = pickedFrom(ctx);
	const picked = page.picked;
	return h(
		"div",
		{ class: "members-stage" },
		h(
			"p",
			{ class: "members-summary" },
			h(
				"b",
				null,
				t("{n} agents work for {m} members.", { n: String(ctx.data.agents.length), m: String(seats.length) }),
			),
			waiting.length
				? h("span", { class: "members-summary-warn" }, t("{n} can't work right now", { n: String(waiting.length) }))
				: null,
			none.length ? h("span", null, t("{n} with no agents yet", { n: String(none.length) })) : null,
		),
		moveBar(container, ctx, true),
		h(
			"div",
			{ class: "members-tiles", role: "list" },
			...[...seats]
				.sort(
					(a, b) =>
						Number(b.you) - Number(a.you) ||
						Number(stuck(b)) - Number(stuck(a)) ||
						b.agents.length - a.agents.length,
				)
				.map((seat) => {
					const used = seat.login?.state === "full" ? 100 : (seat.login?.usedPercent ?? 0);
					const face = personAvatar(seat.name, seat.id);
					face.classList.add("members-face");
					face.style.setProperty("--face", "40px");
					const target = from !== undefined && sendable(ctx, from, seat.id);
					const state = seat.login?.state;
					const tile = h(
						"button",
						{
							class: `members-tile${seat === shown ? " is-open" : ""}${target ? " is-target" : ""}${stuck(seat) ? " is-warn" : ""}`,
							type: "button",
							role: "listitem",
							"aria-pressed": String(seat === shown),
							disabled: picked !== undefined && !target,
							onclick: () => {
								if (picked && target) void act(container, page, () => ask(ctx, [picked], seat.id));
								else {
									page.open = seat.id;
									ctx.redraw();
								}
							},
						},
						h("span", { class: "members-ring is-small", style: `--used:${used};--seat:${seat.colour}` }, face),
						h(
							"span",
							{ class: "members-tile-copy" },
							h("b", { class: "members-tile-name" }, seat.you ? t("You") : firstName(seat.name)),
							state === "full"
								? h(
										"span",
										{ class: "members-tile-warn" },
										seat.login?.resetsAt
											? t("Full until {time}", { time: resetTime(seat.login.resetsAt) })
											: t("Full for now"),
									)
								: state === "sign_in"
									? h("span", { class: "members-tile-warn" }, t("Needs to sign in"))
									: h(
											"span",
											{ class: "members-tile-count" },
											seat.agents.length === 1
												? t("1 agent")
												: t("{n} agents", { n: String(seat.agents.length) }),
										),
							h(
								"span",
								{ class: "members-tile-faces" },
								...seat.agents.slice(0, 5).map((agent) => agentFigure(agent, "", { size: 22, still: true })),
								seat.agents.length > 5 ? h("small", null, `+${seat.agents.length - 5}`) : null,
							),
						),
					);
					tile.style.setProperty("--seat", seat.colour);
					return tile;
				}),
		),
		shown ? mat(container, ctx, shown) : null,
	);
}
