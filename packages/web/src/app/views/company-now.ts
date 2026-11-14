import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import {
	parseCompanyStateFile,
	READING_FILE_MAX_BYTES,
	READING_FOUNDERS,
	READING_PATH,
	type ReadingFile,
} from "@qorpera/cloud-client/company-state-files";
import { CloudRpcError } from "../../cloud/client.ts";
import { type CompanyStanding, RUNNING } from "../../cloud/company-standing.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { AGENT_LOOK } from "../../ui/agent-activity.ts";
import { agentFigure, type FigureOptions } from "../../ui/avatar.ts";
import { h, icon, personAvatar } from "../../ui/dom.ts";
import { leave, playOnce } from "../../ui/motion.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { designPx, uiScale } from "../../ui/scale.ts";
import { thingShape } from "../../ui/thing-shapes.ts";
import type { CompanyController } from "../company.ts";
import {
	CANVAS,
	COLUMN_BELOW,
	FIGURE,
	figureSpots,
	type LayoutThing,
	layoutReading,
	type ReadingLayout,
} from "../reading-layout.ts";
import { statusDisc } from "./shell.ts";

/* The company's page, `#/c/{id}/now` (Jonas, 14 November 2026: "I think the company's stage is more fluent than a set
 * value, but I also do think there needs to be some form of awareness about the state/stage of the company. It should
 * feel like the company is conscious almost."). The company's name in the rail opens it. It draws the company's
 * reading of itself (QorperaOS/vision/reading.md, which the Co-Founder keeps) as a picture: the company's sentence as
 * the one title and its short line under it; each thing of the reading as its shape, pale and filled from the bottom as
 * far as it is known or built; the agents that attend to it at its corners, as the rail draws them; the members it
 * waits for, by their faces. Where the things stand is the page's own rule (app/reading-layout.ts), never the file's.
 * When the file changes, the same shapes and figures move, grow and fill. A company whose routines stand still
 * (`qorpera_read_company_standing`) turns grey and still, and says since when and why. Before the first reading the
 * company's figures stand in a row. At the foot, a question to the company goes to the Co-Founder's thread as the
 * member's own message.
 *
 * It is drawn as the Members page is: what it was drawn from is a key, and a draw that changes none of it leaves the
 * page alone; reads that answer after the page went away draw nothing. Unlike Members, a draw keeps every shape and
 * figure element by its key (the thing's key, the agent's id), so a change moves them instead of drawing them anew. */

/** How often the page reads the company's standing and its reading again while it is open. */
const READ_EVERY_MS = 30_000;
/** A pane the page has not measured yet: the sketch's, 1052 x 925 screen pixels at the Big scale, under its title. */
const UNMEASURED: Pane = { width: CANVAS.width / 1.3, height: CANVAS.height / 1.3, screen: CANVAS.width };
/** The change line's small figures, in design pixels. */
const CHANGE_FIGURE = 22;
const TEXT = new TextDecoder("utf-8", { fatal: true });

/** The picture's pane: its size in design pixels, and its width in screen pixels. */
interface Pane {
	readonly width: number;
	readonly height: number;
	readonly screen: number;
}

export type NowFolder = Pick<CloudMemberFolderClient, "read" | "readFile" | "stateFolders">;

export interface CompanyNowHost {
	/** The member's own folder client, under the company's checks. */
	readonly folder: () => NowFolder;
	/** Tells the listener of each change hint of the company's folder; returns how to stop. */
	readonly onFolderChange: (listener: () => void) => () => void;
	/** The company's standing; an older backend without the read throws a missing function. */
	readonly standing: () => Promise<CompanyStanding>;
	readonly openSettings: (tab: "ai-subscriptions") => void;
	/** Hands the member's question to the Co-Founder's thread as their own message, and opens that thread. */
	readonly ask: (text: string) => Promise<void>;
	/** Opens the Co-Founder's thread with `text` in its composer, for the member to send or change. */
	readonly draft: (text: string) => Promise<void>;
}

interface ThingParts {
	readonly el: HTMLElement;
	readonly shape: HTMLElement;
	readonly paths: readonly SVGPathElement[];
	readonly dash: SVGSVGElement;
	readonly fill: HTMLElement;
	readonly name: HTMLElement;
	readonly state: HTMLElement;
}

interface FigureParts {
	readonly el: HTMLElement;
	/** What the figure inside was built for: built again only when this changes. */
	look: string;
}

/** One figure at a thing: an agent, or the face of a member the thing waits for. */
interface Stand {
	readonly key: string;
	readonly agent?: HostedStaffAgent;
	readonly member?: { readonly userId: string; readonly name: string };
}

const SVG = "http://www.w3.org/2000/svg";
function svgShape(className: string, d: string): { svg: SVGSVGElement; path: SVGPathElement } {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 100 100");
	svg.setAttribute("class", className);
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(SVG, "path");
	path.setAttribute("d", d);
	svg.append(path);
	return { svg, path };
}

/** An agent's folder name is the slug of its name when it was hired: how an ended agent's line finds its figure. */
function slug(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** A moment in a line: the time today, the weekday and time within a week, else the date. */
function when(iso: string): string {
	const at = new Date(iso);
	const now = new Date();
	const options: Intl.DateTimeFormatOptions =
		at.toDateString() === now.toDateString()
			? { hour: "2-digit", minute: "2-digit" }
			: Math.abs(now.getTime() - at.getTime()) < 6 * 24 * 3600 * 1000
				? { weekday: "long", hour: "2-digit", minute: "2-digit" }
				: { day: "numeric", month: "long" };
	return new Intl.DateTimeFormat(presentationLocale(), options).format(at);
}

export class CompanyNowView {
	readonly el: HTMLElement;
	readonly #company: CompanyController;
	readonly #host: CompanyNowHost;
	readonly #lifetime = new AbortController();
	readonly #heading = h("h1", { class: "visually-hidden" });
	readonly #title = h("h2", { class: "now-title" });
	readonly #line = h("p", { class: "now-line" });
	readonly #settings = h("button", { class: "now-settings", type: "button" });
	readonly #stage = h("div", { class: "now-stage" });
	readonly #canvas = h("div", { class: "now-canvas" });
	readonly #changes = h("div", { class: "now-changes", role: "group" });
	readonly #note = h("p", { class: "now-note", role: "alert", hidden: true });
	readonly #input = h("textarea", { class: "composer-input", rows: "1" });
	readonly #send = h("button", { class: "composer-send", type: "submit", disabled: true }, icon("send"));
	readonly #things = new Map<string, ThingParts>();
	readonly #figures = new Map<string, FigureParts>();
	/** The reading as last read: undefined until the first read answered, null when the company has none. */
	#reading: ReadingFile | null | undefined;
	#version: string | undefined;
	/** Each live agent's id by its folder's name, as the member's state folders last said. */
	#handles = new Map<string, string>();
	/** The live agents the handles were read for, so a hire reads them again. */
	#handlesFor = "";
	#standing: CompanyStanding = RUNNING;
	/** The backend has no standing read: the company counts as running and the page asks no more. */
	#standingMissing = false;
	/** The read of the reading under way, which a hint meanwhile joins; `#again` asks for one more after it. */
	#reading$: Promise<void> | undefined;
	#again = false;
	/** "Not right?" is on its way to the Co-Founder's thread: another press does nothing. */
	#drafting = false;
	#pane = UNMEASURED;
	#drawn: string | undefined;
	/** The reading was drawn as a picture before: what is new in the next one arrives. */
	#pictured = false;
	#busy = false;
	#stopHints: () => void = () => {};
	#timer: ReturnType<typeof setInterval> | undefined;
	#observer: ResizeObserver | undefined;

	constructor(company: CompanyController, host: CompanyNowHost) {
		this.#company = company;
		this.#host = host;
		const form = h(
			"form",
			{ class: "composer now-ask" },
			h("div", { class: "composer-shell" }, h("div", { class: "composer-field" }, this.#input), this.#send),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.#ask();
		});
		this.#input.addEventListener("input", () => {
			this.#send.disabled = this.#busy || !this.#input.value.trim();
		});
		// Return sends, as the thread's composer does; Shift+Return is a new line.
		this.#input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			void this.#ask();
		});
		this.#settings.addEventListener("click", () => this.#host.openSettings("ai-subscriptions"));
		this.#stage.append(this.#canvas);
		this.el = h(
			"section",
			{ class: "page company-now" },
			this.#heading,
			h("div", { class: "now-head" }, this.#title, this.#line, this.#settings),
			this.#stage,
			this.#changes,
			this.#note,
			form,
		);
		const signal = this.#lifetime.signal;
		// The page ends with its company, whatever else holds it (review r1 F2).
		company.signal.addEventListener("abort", () => this.dispose(), { once: true, signal });
		this.#stopHints = host.onFolderChange(() => void this.#readReading());
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState !== "visible") return;
				void this.#readReading();
				void this.#readStanding();
			},
			{ signal },
		);
		this.#timer = setInterval(() => {
			void this.#readReading();
			void this.#readStanding();
		}, READ_EVERY_MS);
		if (typeof ResizeObserver === "function") {
			this.#observer = new ResizeObserver(() => this.#measure());
			this.#observer.observe(this.#stage);
		}
		void this.#readReading();
		void this.#readStanding();
		this.update();
	}

	dispose(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#lifetime.abort();
		this.#stopHints();
		clearInterval(this.#timer);
		this.#observer?.disconnect();
	}

	focus(): void {
		this.#input.focus();
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#draw();
	}

	#measure(): void {
		const box = this.#stage.getBoundingClientRect();
		if (box.width <= 0) return;
		const scale = uiScale();
		const next: Pane = { width: box.width / scale, height: box.height / scale, screen: box.width };
		if (
			Math.round(next.width) === Math.round(this.#pane.width) &&
			Math.round(next.height) === Math.round(this.#pane.height)
		)
			return;
		this.#pane = next;
		this.#draw();
	}

	/** Reads the reading. A read asked for while one is under way joins it and reads once more after it, so on a slow
	 * link every answer still lands (review r1 F3 of #1818): a newer read never throws an older one's answer away. */
	#readReading(): Promise<void> {
		if (this.#reading$) {
			this.#again = true;
			return this.#reading$;
		}
		const run = async () => {
			do {
				this.#again = false;
				await this.#readOnce();
			} while (this.#again && !this.#lifetime.signal.aborted);
		};
		this.#reading$ = run().finally(() => {
			this.#reading$ = undefined;
		});
		return this.#reading$;
	}

	async #readOnce(): Promise<void> {
		const signal = this.#lifetime.signal;
		let reading = this.#reading;
		let version = this.#version;
		let handles = this.#handles;
		let handlesFor = this.#handlesFor;
		try {
			const folder = this.#host.folder();
			const { entry } = await folder.read(READING_PATH, signal);
			if (!entry?.file || entry.kind !== "file") {
				reading = null;
				version = undefined;
			} else if (entry.file.bytes > READING_FILE_MAX_BYTES) {
				// Too large to be a reading: like one that does not read, it keeps the last that did (review r1 F5).
				reading ??= null;
			} else if (entry.version !== version || reading === undefined) {
				const text = TEXT.decode(
					await folder.readFile(entry.file, signal, READING_FILE_MAX_BYTES, { cached: true }),
				);
				const parsed = parseCompanyStateFile(READING_PATH, text);
				// A file that does not read keeps the last reading that did; with none, the company has none yet.
				if (parsed?.ok && parsed.file.kind === "reading") reading = parsed.file;
				else reading ??= null;
				version = entry.version;
			}
			// The agents' folder names, read again when the reading or the company's agents changed.
			const live = this.#liveIds();
			if (reading && (version !== this.#version || live !== handlesFor || !handles.size)) {
				const folders = await folder.stateFolders(signal);
				handles = new Map(
					folders.agents.flatMap((item) => {
						const handle = item.file.split("/").at(-2);
						return handle ? [[handle, item.staffAgentId.toLowerCase()] as const] : [];
					}),
				);
				handlesFor = live;
			}
		} catch {
			// The next hint, the clock or the tab coming back reads again; what was read stays.
			if (signal.aborted) return;
		}
		// An answer that comes after the page went away draws nothing.
		if (signal.aborted) return;
		this.#reading = reading;
		this.#version = version;
		this.#handles = handles;
		this.#handlesFor = handlesFor;
		this.#draw();
	}

	async #readStanding(): Promise<void> {
		if (this.#standingMissing) return;
		const signal = this.#lifetime.signal;
		try {
			const standing = await this.#host.standing();
			if (signal.aborted) return;
			this.#standing = standing;
		} catch (error) {
			if (signal.aborted) return;
			// An older backend: the company counts as running, and is not asked again.
			if (error instanceof CloudRpcError && error.missing) {
				this.#standingMissing = true;
				this.#standing = RUNNING;
			} else return;
		}
		this.#draw();
	}

	#liveIds(): string {
		return this.#company.store
			.get()
			.staff.filter((agent) => agent.employmentStatus === "active")
			.map((agent) => agent.id)
			.sort()
			.join(",");
	}

	async #ask(): Promise<void> {
		const text = this.#input.value.trim();
		if (!text || this.#busy) return;
		this.#busy = true;
		this.#send.disabled = true;
		this.#note.hidden = true;
		try {
			await this.#host.ask(text);
			this.#input.value = "";
		} catch (error) {
			this.#note.textContent = error instanceof Error ? error.message : String(error);
			this.#note.hidden = false;
		} finally {
			this.#busy = false;
			this.#send.disabled = !this.#input.value.trim();
		}
	}

	async #notRight(lines: readonly string[]): Promise<void> {
		if (this.#drafting) return;
		this.#drafting = true;
		this.#note.hidden = true;
		try {
			await this.#host.draft(t("Not right: {changes}.", { changes: lines.join("; ") }));
		} catch (error) {
			this.#note.textContent = error instanceof Error ? error.message : String(error);
			this.#note.hidden = false;
		} finally {
			this.#drafting = false;
		}
	}

	/** The company's agents at work, by id, and its members. */
	#people() {
		const state = this.#company.store.get();
		const staff = new Map(
			state.staff
				.filter((agent) => agent.employmentStatus === "active")
				.map((agent) => [agent.id.toLowerCase(), agent]),
		);
		const members = new Map(
			(state.team?.members ?? []).map((member) => [member.userId, member.displayName || member.email]),
		);
		// The founders a thing's `waits_for: founders` names: the company's owners (views/team.ts).
		const founders = (state.team?.members ?? [])
			.filter((member) => member.role === "owner")
			.map((member) => member.userId);
		return { state, staff, members, founders };
	}

	/** The look of an agent's figure: as the rail draws it (views/shell.ts railFigure), or grey and still. */
	#agentLook(agent: HostedStaffAgent, still: boolean) {
		const state = this.#company.agentState(agent.id);
		const look = AGENT_LOOK[state];
		const waiting = this.#company.waitingFor(agent.id);
		const ask: FigureOptions["ask"] = waiting
			? waiting.kind === "question"
				? "question"
				: "bang"
			: state === "decision"
				? "bang"
				: undefined;
		return { state, look, ask: still ? undefined : ask };
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const { state, staff, members, founders } = this.#people();
		const reading = this.#reading;
		const standing = this.#standing;
		const still = standing.stopped;
		const companyName = this.#company.profile.profileName;
		const agentOf = (handle: string) => {
			const id = this.#handles.get(handle);
			return id ? staff.get(id) : undefined;
		};
		const looks = [...staff.values()].map((agent) => [agent.id, JSON.stringify(this.#agentLook(agent, still))]);
		const key = JSON.stringify([
			presentationLocale(),
			companyName,
			// Not read yet is not "none": JSON writes undefined in a list as null.
			reading === undefined ? "unread" : reading,
			standing,
			[...this.#handles],
			state.staff.map((agent) => [agent.id, agent.displayName, agent.employmentStatus, agent.appearance]),
			[...members],
			founders,
			looks,
			Math.round(this.#pane.width),
			Math.round(this.#pane.height),
			this.#pane.screen < COLUMN_BELOW,
		]);
		if (key === this.#drawn) return;
		this.#drawn = key;
		this.#heading.textContent = companyName;
		const placeholder = t("Ask {company}…", { company: companyName });
		this.#input.placeholder = placeholder;
		this.#input.setAttribute("aria-label", placeholder);
		this.#send.setAttribute("aria-label", t("Send"));
		this.#changes.setAttribute("aria-label", t("What changed"));
		this.el.classList.toggle("is-still", still);
		this.#words(reading, standing, members);
		if (reading === undefined) {
			this.#place([], [], undefined);
			this.#drawChanges(null, staff);
			return;
		}
		if (reading === null) {
			// No reading yet: the company's figures in a row, the Co-Founder first. No shapes.
			const cofounder = this.#company.cofounderId()?.toLowerCase();
			const row = [...staff.values()].sort(
				(a, b) => Number(b.id === cofounder) - Number(a.id === cofounder) || a.createdAt.localeCompare(b.createdAt),
			);
			this.el.classList.add("is-unread");
			this.#place(
				[],
				row.map((agent) => ({ key: agent.id, agent })),
				undefined,
			);
			this.#drawChanges(null, staff);
			return;
		}
		this.el.classList.remove("is-unread");
		// Each thing with the agents the company has (one whose role ended, or the file names but the company does not
		// have, is not drawn) and the members it waits for.
		const viewer = this.#company.userId;
		const seen = new Map<string, number>();
		const keyOf = (id: string) => {
			const count = (seen.get(id) ?? 0) + 1;
			seen.set(id, count);
			return count === 1 ? id : `${id}#${count}`;
		};
		const placed = reading.things.map((thing) => {
			const agents = thing.agents.flatMap((handle) => {
				const agent = agentOf(handle);
				return agent ? [{ key: keyOf(agent.id), agent } satisfies Stand] : [];
			});
			const waiting = [
				// "founders" is every owner: the viewer's own face only when they are one (review r1 F1).
				...new Set(
					thing.waitsFor.flatMap((entry) => (entry === READING_FOUNDERS ? founders : [entry.toLowerCase()])),
				),
			].flatMap((userId) => {
				const name = userId === viewer ? (members.get(viewer) ?? t("You")) : members.get(userId);
				return name ? [{ key: keyOf(`member:${userId}`), member: { userId, name } } satisfies Stand] : [];
			});
			return { thing, agents, waiting };
		});
		const layout = layoutReading(
			placed.map(({ thing, agents }): LayoutThing => ({ key: thing.key, agents: agents.length })),
			reading.attention,
			this.#pane,
			this.#pane.screen,
		);
		this.#place(placed, [], layout);
		this.#drawChanges(reading, staff);
	}

	/** The title, its line and the button under them. */
	#words(reading: ReadingFile | null | undefined, standing: CompanyStanding, members: ReadonlyMap<string, string>) {
		this.#settings.hidden = true;
		if (standing.stopped) {
			this.#title.textContent = standing.since
				? t("We have stood still since {time}.", { time: when(standing.since) })
				: t("We have stood still.");
			const you = standing.member === null || standing.member === this.#company.userId;
			const member = standing.member ? (members.get(standing.member)?.split(/\s+/)[0] ?? "") : "";
			const reason =
				standing.why === "login_full"
					? [
							you || !member
								? t("Your ChatGPT is full, so none of us can work.")
								: t("{member}'s ChatGPT is full, so none of us can work.", { member }),
							standing.resetsAt
								? Date.parse(standing.resetsAt) - Date.now() < 24 * 3600 * 1000
									? t("It opens again at {time}.", { time: when(standing.resetsAt) })
									: t("It opens again on {date}.", {
											date: new Intl.DateTimeFormat(presentationLocale(), {
												day: "numeric",
												month: "long",
											}).format(new Date(standing.resetsAt)),
										})
								: "",
						]
							.filter(Boolean)
							.join(" ")
					: standing.why === "sign_in"
						? you || !member
							? t("Your ChatGPT needs a new sign-in, so none of us can work.")
							: t("{member}'s ChatGPT needs a new sign-in, so none of us can work.", { member })
						: standing.why === "no_login"
							? you || !member
								? t("You have not connected ChatGPT, so none of us can work.")
								: t("{member} has no ChatGPT yet, so none of us can work.", { member })
							: "";
			this.#line.textContent = reason;
			this.#line.hidden = !reason;
			if (standing.why) {
				this.#settings.hidden = false;
				this.#settings.textContent =
					standing.why === "login_full"
						? t("Use another sign-in")
						: standing.why === "sign_in"
							? t("Sign in again")
							: t("Connect ChatGPT");
			}
			return;
		}
		if (reading === null) {
			this.#title.textContent = t("We are finding our feet. The first reading comes with the next plan.");
			this.#line.hidden = true;
			return;
		}
		this.#title.textContent = reading?.sentence ?? "";
		this.#line.textContent = reading?.line ?? "";
		this.#line.hidden = !reading?.line;
	}

	/** Puts the things and the figures where the layout says, keeping each element by its key so it moves. */
	#place(
		placed: readonly {
			thing: ReadingFile["things"][number];
			agents: readonly Stand[];
			waiting: readonly Stand[];
		}[],
		row: readonly Stand[],
		layout: ReadingLayout | undefined,
	): void {
		const still = this.#standing.stopped;
		const arriving = this.#pictured;
		const canvas = this.#canvas;
		canvas.classList.toggle("is-column", layout?.column === true);
		canvas.classList.toggle("is-row", row.length > 0);
		const unit = layout?.unit ?? 1 / 1.3;
		canvas.style.setProperty("--u", designPx(unit));
		if (layout) {
			canvas.style.width = designPx(layout.width);
			canvas.style.height = designPx(layout.height);
		} else {
			canvas.style.removeProperty("width");
			canvas.style.removeProperty("height");
		}
		const keepThings = new Set<string>();
		const keepFigures = new Set<string>();
		const spots = new Map(layout?.spots.map((spot) => [spot.key, spot]));
		for (const { thing, agents, waiting } of placed) {
			const spot = spots.get(thing.key);
			if (!spot) continue;
			keepThings.add(thing.key);
			let parts = this.#things.get(thing.key);
			const fresh = !parts;
			if (!parts) {
				parts = this.#thingParts(thing.key);
				this.#things.set(thing.key, parts);
			}
			const width = spot.box.right - spot.box.left;
			parts.el.style.left = designPx(spot.box.left);
			parts.el.style.top = designPx(spot.y - spot.size / 2);
			parts.el.style.width = designPx(width);
			parts.shape.style.width = designPx(spot.size);
			parts.shape.style.height = designPx(spot.size);
			parts.shape.style.setProperty("--size", designPx(spot.size));
			parts.shape.setAttribute("aria-label", `${thing.name}: ${thing.state}`);
			const d = thingShape(thing.shape);
			for (const path of parts.paths) if (path.getAttribute("d") !== d) path.setAttribute("d", d);
			parts.fill.style.height = `${thing.full}%`;
			parts.el.classList.toggle("is-empty", thing.full === 0);
			parts.el.classList.toggle("is-attended", thing.key === this.#reading?.attention);
			parts.name.textContent = thing.name;
			parts.state.textContent = thing.state;
			if (parts.el.parentElement !== canvas) canvas.append(parts.el);
			if (fresh && arriving) playOnce(parts.el, "is-arriving");
			const stands = [...agents, ...waiting];
			figureSpots(spot, unit, stands.length, waiting.length).forEach((at, index) => {
				const stand = stands[index]!;
				keepFigures.add(stand.key);
				this.#stand(stand, at.left, at.top, at.size, still, arriving);
			});
		}
		// No reading: the figures stand in a row, in the page's flow.
		row.forEach((stand) => {
			keepFigures.add(stand.key);
			this.#stand(stand, null, null, FIGURE / 1.3, still, false);
		});
		for (const [key, parts] of this.#things)
			if (!keepThings.has(key)) {
				this.#things.delete(key);
				leave(parts.el, "is-leaving", () => parts.el.remove());
			}
		for (const [key, parts] of this.#figures)
			if (!keepFigures.has(key)) {
				this.#figures.delete(key);
				leave(parts.el, "is-leaving", () => parts.el.remove());
			}
		// Nothing that stays is put in again: an element taken out and back would end its move where it is going, with
		// no move. The figures stand over the things by their z-index (styles/company-now.css).
		this.#pictured = layout !== undefined;
	}

	#thingParts(key: string): ThingParts {
		const dash = svgShape("now-dash", "");
		const pale = svgShape("now-pale", "");
		const solid = svgShape("now-solid", "");
		const fill = h("div", { class: "now-fill" });
		fill.append(solid.svg);
		const shape = h("div", { class: "now-shape", role: "img" });
		shape.append(dash.svg, pale.svg, fill);
		const name = h("div", { class: "now-thing-name" });
		const state = h("div", { class: "now-thing-state" });
		const el = h("div", { class: "now-thing", "data-thing": key }, shape, name, state);
		return { el, shape, paths: [dash.path, pale.path, solid.path], dash: dash.svg, fill, name, state };
	}

	/** One figure, built once per key and moved after; what it shows is built again only when its look changed. `left`
	 * null puts it in the page's flow (the row before the first reading). */
	#stand(
		stand: Stand,
		left: number | null,
		top: number | null,
		size: number,
		still: boolean,
		arriving: boolean,
	): void {
		let parts = this.#figures.get(stand.key);
		const fresh = !parts;
		const profileId = this.#company.profile.profileId;
		if (!parts) {
			const agent = stand.agent;
			const cofounder = agent && agent.id.toLowerCase() === this.#company.cofounderId()?.toLowerCase();
			const el = agent
				? h("a", {
						class: "now-figure",
						href: cofounder ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agent.id}`,
						"data-agent": agent.id,
					})
				: h("span", { class: "now-figure now-face", "data-member": stand.member?.userId });
			parts = { el, look: "" };
			this.#figures.set(stand.key, parts);
		}
		const el = parts.el;
		if (left === null || top === null) {
			el.classList.add("is-flow");
			el.style.removeProperty("left");
			el.style.removeProperty("top");
		} else {
			el.classList.remove("is-flow");
			el.style.left = designPx(left);
			el.style.top = designPx(top);
		}
		el.style.width = designPx(size);
		el.style.height = designPx(size);
		el.classList.toggle("is-still", still);
		const agent = stand.agent;
		if (agent) {
			const { look, ask } = this.#agentLook(agent, still);
			const shown = JSON.stringify([agent.displayName, agent.appearance, still, look.figure, look.disc, ask]);
			el.setAttribute("aria-label", agent.displayName);
			el.title = agent.displayName;
			if (parts.look !== shown) {
				parts.look = shown;
				const options: FigureOptions = still
					? { size, activity: "Idle", still: true }
					: { size, activity: look.figure, alive: true, ...(ask ? { ask } : {}) };
				const disc = still ? null : statusDisc(look, "now-figure-status");
				el.replaceChildren(agentFigure(agent, agent.displayName, options), ...(disc ? [disc] : []));
			}
			const figure = el.querySelector<HTMLElement>(".figure");
			figure?.style.setProperty("--figure-size", designPx(size));
		} else if (stand.member) {
			const shown = JSON.stringify([stand.member.userId, stand.member.name]);
			el.title = stand.member.name;
			el.setAttribute("aria-label", stand.member.name);
			el.setAttribute("role", "img");
			if (parts.look !== shown) {
				parts.look = shown;
				el.replaceChildren(personAvatar(stand.member.name, stand.member.userId));
			}
		}
		if (el.parentElement !== this.#canvas) this.#canvas.append(el);
		if (fresh && arriving && !still) playOnce(el, "is-arriving");
	}

	/** The quiet line of what changed in the team, with "Not right?". Not while the company stands still. */
	#drawChanges(reading: ReadingFile | null, staff: ReadonlyMap<string, HostedStaffAgent>): void {
		const changes = reading && !this.#standing.stopped ? reading.changes : [];
		this.#changes.hidden = changes.length === 0;
		if (!changes.length) {
			this.#changes.replaceChildren();
			return;
		}
		const all = this.#company.store.get().staff;
		const items = changes.flatMap((change, index) => {
			const id = this.#handles.get(change.agent);
			const agent =
				(id ? staff.get(id) : undefined) ?? all.find((candidate) => slug(candidate.displayName) === change.agent);
			const ended = change.what === "ended";
			const figure = agent
				? agentFigure(agent, agent.displayName, {
						size: CHANGE_FIGURE,
						still: true,
						className: "now-change-figure",
					})
				: null;
			return [
				index ? h("span", { class: "now-change-dot", "aria-hidden": "true" }, "·") : null,
				h("span", { class: `now-change${ended ? " is-ended" : ""}` }, figure, h("span", null, change.line)),
			];
		});
		const lines = changes.map((change) => change.line);
		this.#changes.replaceChildren(
			...items.filter((item) => item !== null),
			h("button", { class: "now-pill", type: "button", onclick: () => void this.#notRight(lines) }, t("Not right?")),
		);
	}
}
