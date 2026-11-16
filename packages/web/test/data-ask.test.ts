// @vitest-environment jsdom

import type {
	CloudMemberDataAnswer,
	CloudMemberDataDescription,
	CloudMemberDataPage,
} from "@qorpera/cloud-client/cloud-member-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyDatabases, type CompanyDataCalls } from "../src/app/company-data.ts";
import { type DataAskSend, dataAskLine } from "../src/app/data-ask.ts";
import { wantDataList } from "../src/app/data-page.ts";
import type { TellNote } from "../src/app/tell-agent.ts";
import { renderData } from "../src/app/views/data.ts";
import { pageNoteApp, pageNoteCard } from "../src/app/views/page-note.ts";
import { appNoteHeader } from "../src/cloud/wall-reply.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

const etag = "0123456789abcdef0123456789abcdef";
const asOf = "2026-11-16T10:00:00.000Z";

const described = (mine = false): CloudMemberDataDescription => ({
	databases: [
		{
			database: "workshop",
			name: "Workshop",
			about: null,
			write: true,
			list: true,
			applied: [],
			tables: [
				{
					name: "repairs",
					kind: "table",
					key: ["id"],
					rows: 1,
					columns: [
						{ name: "id", type: "integer", settable: false },
						{ name: "bike", type: "text", settable: true },
					],
				},
			],
			questions: [
				{ name: "waited-over-a-week", words: "Repairs that waited over a week.", parameters: [] },
				{
					name: "handed-in-since",
					words: "Repairs handed in since a day.",
					parameters: mine ? ["since", "viewer", "state"] : ["since", "state"],
				},
				{ name: "broken", words: null, parameters: null, problem: "two statements" },
				{ name: "Orders_Last", words: "A name the gateway refuses.", parameters: [] },
			],
			changes: [],
		},
	],
	companyBytes: 1000,
	limitBytes: 1_000_000_000,
});

const page: CloudMemberDataPage = {
	columns: ["id", "bike"],
	key: ["id"],
	rows: [{ values: [1, "Gazelle Orange C7"], seen: "0".repeat(64) }],
	more: false,
	etag,
	asOf,
};

const calls = (mine = false) =>
	({
		describe: vi.fn(async () => described(mine)),
		rows: vi.fn(async () => page),
		query: vi.fn(
			async (): Promise<CloudMemberDataAnswer> => ({
				columns: ["bike"],
				rows: [["Trek FX 2"]],
				more: false,
				etag,
				asOf,
			}),
		),
		edit: vi.fn(async () => {
			throw new Error("no edits here");
		}),
		changes: vi.fn(async () => ({ writes: [], more: false, days: [], asOf })),
		watchTables: vi.fn(
			(_watches: unknown, signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("put away")), { once: true }),
				),
		),
	}) satisfies CompanyDataCalls;

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	location.hash = "";
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function open(options: { send?: DataAskSend; write?: boolean; cofounder?: boolean; mine?: boolean } = {}) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: [
			{
				...staff,
				id: id(40),
				displayName: "Kaya",
				templateId: "co-founder",
				employmentStatus: options.cofounder === false ? "archived" : "active",
			},
		],
		sessions: [session],
		team: {
			...team,
			capabilities: { ...team.capabilities, write: options.write ?? true },
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			],
		},
		companyData: described(options.mine),
	});
	cleanup.push(() => controller.stop());
	const data = calls(options.mine);
	const databases = new CompanyDatabases(
		() => data,
		(next) => controller.store.set({ companyData: next }),
		controller.signal,
	);
	const container = document.createElement("main");
	document.body.append(container);
	const draw = () => renderData(container, controller, databases, options.send);
	draw();
	cleanup.push(controller.store.subscribe(draw));
	await settle();
	return { container, calls: data, controller };
}

const tab = (root: ParentNode, label: string) => {
	const found = [...root.querySelectorAll<HTMLButtonElement>(".data-tab")].find(
		(one) => one.textContent?.trim() === label,
	);
	if (!found) throw new Error(`No tab ${label}`);
	return found;
};

const fill = (field: HTMLInputElement, value: string, event: "input" | "change" = "input") => {
	field.value = value;
	field.dispatchEvent(new Event(event, { bubbles: true }));
};

describe("Ask under the list", () => {
	it("sends the question to the Co-Founder with the list it was asked on, and opens the conversation", async () => {
		const sent: { agentId: string; note: TellNote }[] = [];
		const send: DataAskSend = vi.fn(async (agentId, note) => {
			sent.push({ agentId, note });
			return { sent: true, href: `#/c/${profileA.profileId}` };
		});
		const { container } = await open({ send });
		const box = container.querySelector<HTMLFormElement>(".data-ask-box");
		const field = container.querySelector<HTMLInputElement>(".data-ask-field");
		const go = container.querySelector<HTMLButtonElement>(".data-ask-send");
		expect(box?.hidden).toBe(false);
		expect(field?.placeholder).toBe("Ask Kaya about Workshop…");
		expect(go?.disabled).toBe(true);
		fill(field!, "How many repairs waited more than a week in October?");
		expect(go?.disabled).toBe(false);
		box?.requestSubmit();
		await settle();
		expect(sent).toEqual([
			{
				agentId: id(40),
				note: {
					text: "How many repairs waited more than a week in October?",
					quotes: [],
					header: "page:data#workshop.repairs · Workshop · Repairs",
				},
			},
		]);
		expect(location.hash).toBe(`#/c/${profileA.profileId}`);
		expect(field?.value).toBe("");
		expect(field?.disabled).toBe(false);
	});

	it("keeps the words and says where they wait when the conversation holds another page's note", async () => {
		const send: DataAskSend = vi.fn(async () => ({
			sent: false,
			href: `#/c/${profileA.profileId}`,
			held: true as const,
		}));
		const { container } = await open({ send });
		const field = container.querySelector<HTMLInputElement>(".data-ask-field")!;
		fill(field, "Which bikes are ready?");
		container.querySelector<HTMLFormElement>(".data-ask-box")?.requestSubmit();
		await settle();
		expect(location.hash).toBe("");
		expect(field.value).toBe("Which bikes are ready?");
		const said = container.querySelector<HTMLElement>(".data-ask-said");
		expect(said?.hidden).toBe(false);
		expect(said?.textContent).toContain("Kaya already has a note of yours waiting.");
		expect(said?.querySelector("a")?.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}`);
	});

	it("says what went wrong in the box, and the words stay", async () => {
		const send: DataAskSend = vi.fn(async () => {
			throw new Error("The Co-Founder's thread can't be opened here.");
		});
		const { container } = await open({ send });
		const field = container.querySelector<HTMLInputElement>(".data-ask-field")!;
		fill(field, "How many?");
		container.querySelector<HTMLFormElement>(".data-ask-box")?.requestSubmit();
		await settle();
		expect(container.querySelector(".data-ask-said")?.textContent).toBe(
			"The Co-Founder's thread can't be opened here.",
		);
		expect(field.value).toBe("How many?");
	});

	it("steps aside while What changed is open, and comes back with the list", async () => {
		const { container } = await open({ send: vi.fn() });
		const box = () => container.querySelector<HTMLFormElement>(".data-ask-box");
		expect(box()?.hidden).toBe(false);
		container.querySelector<HTMLButtonElement>(".data-changes-open")?.click();
		await settle();
		expect(container.querySelector(".data-changes")).not.toBeNull();
		expect(box()?.hidden).toBe(true);
		expect(container.querySelector<HTMLElement>(".data-params")?.hidden).toBe(true);
		tab(container, "Repairs").click();
		await settle();
		expect(container.querySelector(".data-changes")).toBeNull();
		expect(box()?.hidden).toBe(false);
	});

	it("is not there for a member who may not write, with no Co-Founder at work, or with no way to send", async () => {
		const send: DataAskSend = vi.fn();
		for (const options of [{ send, write: false }, { send, cofounder: false }, {}]) {
			const { container } = await open(options);
			expect(container.querySelector<HTMLElement>(".data-ask-box")?.hidden).toBe(true);
			document.body.replaceChildren();
		}
	});

	it("names a kept question and what was filled in, and fits the line into an app note", () => {
		const place = {
			database: "workshop",
			databaseName: "Workshop",
			kind: "question" as const,
			name: "handed-in-since",
			title: "Handed in since",
			values: ["2026-10-01", "Ready"],
		};
		expect(dataAskLine(place)).toBe(
			"page:data#workshop:handed-in-since · Workshop · Handed in since · 2026-10-01 · Ready",
		);
		expect(appNoteHeader(dataAskLine(place))).toMatchObject({
			app: "data",
			at: "workshop:handed-in-since",
			page: true,
		});
		const long = dataAskLine({ ...place, kind: "table", name: "Repairs Of Bikes", values: ["x".repeat(80)] });
		const header = appNoteHeader(long);
		expect(header?.at).toBe("workshop");
		expect([...(header?.about ?? "")]).toHaveLength(60);
		expect(header?.about.endsWith("…")).toBe(true);
		expect(appNoteHeader(dataAskLine({ ...place, values: ["@Bea «said»\nso"] }))?.about).toBe(
			"Workshop · Handed in since · Bea said so",
		);
	});
});

describe("a kept question that takes values", () => {
	it("leaves :viewer to Qorpera, and no Ask on a database whose rows are each member's own", async () => {
		const send: DataAskSend = vi.fn();
		const { container } = await open({ send, mine: true });
		expect(container.querySelector<HTMLElement>(".data-ask-box")?.hidden).toBe(true);
		tab(container, "Handed in since").click();
		await settle();
		expect([...container.querySelectorAll(".data-param-label")].map((one) => one.textContent)).toEqual([
			"Since",
			"State",
		]);
		expect(container.querySelector<HTMLElement>(".data-ask-box")?.hidden).toBe(true);
	});

	it("is a tab of its own that asks for its values first, and reads once they are in", async () => {
		const { container, calls } = await open();
		expect([...container.querySelectorAll(".data-tab")].map((one) => one.textContent)).toEqual([
			"Repairs",
			"Waited over a week",
			"Handed in since",
		]);
		tab(container, "Handed in since").click();
		await settle();
		expect(calls.query).not.toHaveBeenCalled();
		const labels = [...container.querySelectorAll(".data-param-label")].map((one) => one.textContent);
		expect(labels).toEqual(["Since", "State"]);
		expect(container.querySelector(".data-empty h1")?.textContent).toBe("Repairs handed in since a day.");
		expect(container.querySelector(".data-empty p")?.textContent).toBe("Fill in Since and State to see the list.");
		const [since, state] = [...container.querySelectorAll<HTMLInputElement>(".data-param-input")];
		fill(since!, " 2026-10-01 ", "change");
		await settle();
		expect(calls.query).not.toHaveBeenCalled();
		expect(container.querySelector(".data-empty p")?.textContent).toBe("Fill in State to see the list.");
		expect(container.querySelector<HTMLInputElement>(".data-param-input")).toBe(since);
		state!.value = "Ready";
		state!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(calls.query).toHaveBeenCalledWith(
			{ database: "workshop", question: "handed-in-since", params: { since: "2026-10-01", state: "Ready" } },
			expect.anything(),
		);
		expect(calls.watchTables).toHaveBeenLastCalledWith(
			[
				{
					database: "workshop",
					question: "handed-in-since",
					params: { since: "2026-10-01", state: "Ready" },
					etag,
				},
			],
			expect.anything(),
		);
		expect(
			[...container.querySelectorAll(".data-row:not(.data-row-head) .is-lead")].map((one) => one.textContent),
		).toEqual(["Trek FX 2"]);
		tab(container, "Repairs").click();
		await settle();
		expect(container.querySelector<HTMLElement>(".data-params")?.hidden).toBe(true);
		tab(container, "Handed in since").click();
		await settle();
		expect([...container.querySelectorAll<HTMLInputElement>(".data-param-input")].map((one) => one.value)).toEqual([
			"2026-10-01",
			"Ready",
		]);
	});

	it("asks with the list's values in what the note is about", async () => {
		const send: DataAskSend = vi.fn(async () => ({ sent: true, href: "#/c/x" }));
		const { container } = await open({ send });
		tab(container, "Handed in since").click();
		await settle();
		const [since, state] = [...container.querySelectorAll<HTMLInputElement>(".data-param-input")];
		fill(since!, "2026-10-01", "change");
		fill(state!, "Ready", "change");
		await settle();
		fill(container.querySelector<HTMLInputElement>(".data-ask-field")!, "Who waited longest?");
		container.querySelector<HTMLFormElement>(".data-ask-box")?.requestSubmit();
		await settle();
		expect(send).toHaveBeenCalledWith(id(40), {
			text: "Who waited longest?",
			quotes: [],
			header: "page:data#workshop:handed-in-since · Workshop · Handed in since · 2026-10-01 · Ready",
		});
	});
});

describe("a kept question's answer", () => {
	it("shows a column of days as the table's days show", async () => {
		const { container, calls } = await open();
		calls.query.mockResolvedValueOnce({
			columns: ["bike", "handed_in"],
			rows: [
				["Trek FX 2", "2026-11-12"],
				["Puch Classic", null],
			],
			more: false,
			etag,
			asOf,
		});
		tab(container, "Waited over a week").click();
		await settle();
		const days = [...container.querySelectorAll(".data-row:not(.data-row-head)")].map(
			(row) => row.querySelectorAll(".data-cell")[1]?.textContent,
		);
		expect(days[0]).toMatch(/12 Nov 2026/);
		expect(days[1]).toBe("");
	});
});

describe("the note in the conversation", () => {
	it("stands as the Data page's card, which opens the list it was asked on", async () => {
		const card = pageNoteCard("data", "workshop:waited-over-a-week", "Workshop · Waited over a week");
		expect(card.dataset.openPage).toBe("data");
		expect(card.dataset.openAt).toBe("workshop:waited-over-a-week");
		expect(card.querySelector(".app-card-title")?.textContent).toBe("Data");
		expect(card.querySelector(".app-card-note")?.textContent).toBe("Workshop · Waited over a week");
		expect(card.querySelector(".app-card-emblem svg")).not.toBeNull();
		expect(pageNoteApp("data").name).toBe("Data");

		wantDataList(profileA.profileId, "workshop:waited-over-a-week");
		const { container, calls } = await open();
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Waited over a week");
		expect(calls.query).toHaveBeenCalledWith(
			{ database: "workshop", question: "waited-over-a-week", params: {} },
			expect.anything(),
		);
		document.body.replaceChildren();
		const again = await open();
		expect(again.container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Repairs");
	});
});
