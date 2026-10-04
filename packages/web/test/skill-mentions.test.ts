// @vitest-environment jsdom

import { CloudMemberFolderAccessDenied, CloudMemberFolderError } from "@qorpera/cloud-client/cloud-member-folder";
import { writeAgentFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { loadSkillSuggestions, SkillLists, type SkillSuggestion } from "../src/cloud/skills.ts";
import type { TranscriptItem } from "../src/cloud/transcript.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { markSkillNames } from "../src/ui/skill-mentions.ts";
import { fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

const SKILLS: SkillSuggestion[] = [
	{ name: "triage", description: "Sort new tickets by urgency.", scope: "agent" },
	{ name: "customer-refund", description: "Refund a customer after approval.", scope: "company" },
	{ name: "monthly-vat-report", description: "Prepare the VAT report each month.", scope: "company" },
];

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function setup(actions: WorkspaceActions = {}, draft?: string, items: TranscriptItem[] = []) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	if (draft !== undefined) company.conversation(session.sessionId).set({ draft });
	// Messages the test places stay: the thread's own read of the transcript never lands.
	if (items.length) vi.mocked(f.api.readSessionEvents).mockReturnValue(new Promise(() => {}));
	if (items.length)
		company.conversation(session.sessionId).set({
			loading: false,
			projection: { items, hiddenCount: 0, lastSequence: items.length },
		});
	const view = new ConversationView(company, session.sessionId, actions);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const field = view.el.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
	const menu = view.el.querySelector<HTMLElement>(".skill-menu")!;
	const list = view.el.querySelector<HTMLElement>(".skill-list")!;
	/** Types the whole text with the caret at its end, as the browser reports it. */
	const type = (text: string) => {
		field.focus();
		field.value = text;
		field.setSelectionRange(text.length, text.length);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const key = (name: string, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
		field.dispatchEvent(event);
		field.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));
		return event;
	};
	const options = () =>
		[...menu.querySelectorAll<HTMLElement>("[role=option]")].map((option) => ({
			name: option.querySelector(".skill-option-name")?.textContent,
			scope: option.querySelector(".skill-option-scope")?.textContent,
			selected: option.getAttribute("aria-selected") === "true",
		}));
	return { ...f, company, view, field, menu, list, type, key, options };
}

describe("calling a skill from the composer", () => {
	it("offers the conversation's skills after a slash and writes the picked name in blue", async () => {
		let answer!: (skills: SkillSuggestion[]) => void;
		const skills = vi.fn(
			() =>
				new Promise<SkillSuggestion[]>((resolve) => {
					answer = resolve;
				}),
		);
		const sendMessage = vi.fn().mockResolvedValue(true);
		const f = setup({ skills, sendMessage });
		// The field names the list as its popup only while it is open (the "@" names do the same).
		expect(f.field.hasAttribute("aria-controls")).toBe(false);
		f.type("Please /");
		expect(f.field.getAttribute("aria-autocomplete")).toBe("list");
		expect(f.field.getAttribute("aria-controls")).toBe(f.list.id);
		// The list is read once, for this agent's thread: its own skills and the company's.
		// The adapter is called a step later, as a failed read if it throws.
		await Promise.resolve();
		expect(skills).toHaveBeenCalledExactlyOnceWith(staff.id, expect.any(AbortSignal));
		expect(f.menu.hidden).toBe(false);
		expect(f.list.getAttribute("aria-busy")).toBe("true");
		expect(f.menu.querySelectorAll(".skeleton")).not.toHaveLength(0);
		answer(SKILLS);
		await settle();
		expect(f.list.hasAttribute("aria-busy")).toBe(false);
		expect(f.options()).toEqual([
			{ name: "/triage", scope: staff.displayName, selected: true },
			{ name: "/customer-refund", scope: "Company", selected: false },
			{ name: "/monthly-vat-report", scope: "Company", selected: false },
		]);
		expect(f.field.getAttribute("aria-activedescendant")).toBe(`${f.list.id}-0`);
		f.type("Please /RE");
		expect(f.options().map((option) => option.name)).toEqual(["/customer-refund", "/monthly-vat-report"]);
		// Neither name starts with "re": nothing is highlighted until an arrow key chooses.
		expect(f.options().some((option) => option.selected)).toBe(false);
		expect(f.key("ArrowDown").defaultPrevented).toBe(true);
		expect(f.key("ArrowDown").defaultPrevented).toBe(true);
		expect(f.options()[1]?.selected).toBe(true);
		expect(f.field.getAttribute("aria-activedescendant")).toBe(`${f.list.id}-1`);
		// Enter picks the skill; it does not send the message.
		expect(f.key("Enter").defaultPrevented).toBe(true);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(f.field.value).toBe("Please /monthly-vat-report ");
		expect(f.field.selectionStart).toBe(f.field.value.length);
		expect(f.menu.hidden).toBe(true);
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Please /monthly-vat-report ");
		const field = f.view.el.querySelector(".composer-field")!;
		expect(field.classList.contains("has-skills")).toBe(true);
		expect([...field.querySelectorAll(".composer-skill")].map((span) => span.textContent)).toEqual([
			"/monthly-vat-report",
		]);
		expect(field.querySelector(".composer-highlight")?.textContent).toBe("Please /monthly-vat-report  ");
		// With the menu closed, Enter sends the message, name and all; the agent loads the skill.
		f.key("Enter");
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Please /monthly-vat-report ",
			expect.any(AbortSignal),
		);
		expect(skills).toHaveBeenCalledOnce();
	});

	it("picks with the pointer or Tab, and keeps a space that already follows", async () => {
		const f = setup({ skills: vi.fn(async () => SKILLS) });
		f.type("/tri");
		await settle();
		f.field.value = "/tri please";
		f.field.setSelectionRange(4, 4);
		f.field.dispatchEvent(new Event("input", { bubbles: true }));
		f.menu.querySelector<HTMLElement>("[role=option]")!.click();
		expect(f.field.value).toBe("/triage please");
		expect(f.field.selectionStart).toBe(7);
		// The caret still sits on the name it just wrote: the menu stays closed.
		f.field.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
		expect(f.menu.hidden).toBe(true);
		f.type("/triage please /cust");
		expect(f.key("Tab").defaultPrevented).toBe(true);
		expect(f.field.value).toBe("/triage please /customer-refund ");
		expect([...f.view.el.querySelectorAll(".composer-skill")].map((span) => span.textContent)).toEqual([
			"/triage",
			"/customer-refund",
		]);
	});

	it("closes on Escape and stays closed while that name is written, and Enter then sends", async () => {
		const sendMessage = vi.fn().mockResolvedValue(true);
		const f = setup({ skills: vi.fn(async () => SKILLS), sendMessage });
		f.type("/mon");
		await settle();
		expect(f.menu.hidden).toBe(false);
		expect(f.key("Escape").defaultPrevented).toBe(true);
		expect(f.menu.hidden).toBe(true);
		f.type("/mont");
		expect(f.menu.hidden).toBe(true);
		f.key("Enter");
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "/mont", expect.any(AbortSignal));
	});

	it("colours only whole names of known skills, and never a slash inside a word", async () => {
		const f = setup({ skills: vi.fn(async () => SKILLS) });
		f.type("/");
		await settle();
		f.type("see a/triage, /nope and (/triage) or /triage.");
		expect([...f.view.el.querySelectorAll(".composer-skill")].map((span) => span.textContent)).toEqual(["/triage"]);
		expect(f.menu.hidden).toBe(true);
		f.type("no skills here");
		expect(f.view.el.querySelector(".composer-field")?.classList.contains("has-skills")).toBe(false);
		expect(f.view.el.querySelector(".composer-highlight")?.childNodes).toHaveLength(0);
	});

	it("colours the names in a restored draft once the list arrives, and offers a group chat the company's", async () => {
		const skills = vi.fn(async () => SKILLS);
		const f = setup({ skills }, "Use /triage today");
		await Promise.resolve();
		expect(skills).toHaveBeenCalledOnce();
		await settle();
		expect(f.view.el.querySelector(".composer-skill")?.textContent).toBe("/triage");
		dispose?.();
		const group = fixture();
		const company = new CompanyController(group.api, profileA, userA.id);
		const room = { ...session, sessionId: id(91), executionScope: { roomId: id(79) }, title: "Team" };
		company.store.set({ team, staff: [staff], sessions: [room], loading: false });
		const roomSkills = vi.fn(async () => SKILLS.filter((skill) => skill.scope === "company"));
		const view = new ConversationView(company, room.sessionId, { skills: roomSkills });
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		const field = view.el.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
		field.focus();
		field.value = "/";
		field.setSelectionRange(1, 1);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await Promise.resolve();
		expect(roomSkills).toHaveBeenCalledExactlyOnceWith(null, expect.any(AbortSignal));
	});

	it("says there are no skills yet, closes after a failed read and tries again only after a pause", async () => {
		const skills = vi.fn<NonNullable<WorkspaceActions["skills"]>>().mockResolvedValueOnce([]);
		const f = setup({ skills });
		f.type("/");
		await settle();
		expect(f.menu.textContent).toBe("No skills yet. Agents save skills as they learn how the company works.");
		// The note stands beside the list, which may only hold options.
		expect(f.list.hidden).toBe(true);
		expect(f.list.childElementCount).toBe(0);
		expect(f.options()).toEqual([]);
		// A name typed with no skill to match closes the menu.
		f.type("/x");
		expect(f.menu.hidden).toBe(true);
		// A minute later the list is read again; this time the read fails.
		vi.advanceTimersByTime(61_000);
		skills.mockRejectedValueOnce(new Error("Company File unavailable"));
		f.type("/");
		await Promise.resolve();
		expect(skills).toHaveBeenCalledTimes(2);
		await settle();
		// The earlier list stays in use while it was being refreshed, and after a failure.
		expect(f.menu.textContent).toBe("No skills yet. Agents save skills as they learn how the company works.");
		f.type("/ ");
		f.type("/");
		expect(skills).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(11_000);
		skills.mockResolvedValueOnce(SKILLS);
		f.type("/t");
		await Promise.resolve();
		expect(skills).toHaveBeenCalledTimes(3);
		await settle();
		expect(f.options().map((option) => option.name)).toEqual(["/triage", "/customer-refund", "/monthly-vat-report"]);
	});

	it("offers a match inside a name or a description, but Enter sends the text as written", async () => {
		const sendMessage = vi.fn().mockResolvedValue(true);
		const skills = vi.fn(
			async (): Promise<SkillSuggestion[]> => [
				{ name: "release-checklist", description: "Ship to production safely.", scope: "company" },
			],
		);
		const f = setup({ skills, sendMessage });
		f.type("Deploy to /prod");
		await settle();
		expect(f.options()).toEqual([{ name: "/release-checklist", scope: "Company", selected: false }]);
		expect(f.field.hasAttribute("aria-activedescendant")).toBe(false);
		expect(f.key("Enter").defaultPrevented).toBe(true);
		expect(f.field.value).toBe("Deploy to /prod");
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Deploy to /prod",
			expect.any(AbortSignal),
		);
		// Chosen on purpose with an arrow key, it is picked.
		f.type("Deploy to /prod");
		f.key("ArrowDown");
		expect(f.options()[0]?.selected).toBe(true);
		f.key("Enter");
		expect(f.field.value).toBe("Deploy to /release-checklist ");
		// A name that only contains the word is not taken either: "/api" is not "/rapid-response".
		skills.mockResolvedValue([{ name: "rapid-response", description: null, scope: "company" }]);
		vi.advanceTimersByTime(61_000);
		sendMessage.mockClear();
		f.type("Call the /api");
		await settle();
		expect(f.options()).toEqual([{ name: "/rapid-response", scope: "Company", selected: false }]);
		f.key("Enter");
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Call the /api", expect.any(AbortSignal));
	});

	it("treats an adapter that throws at once as a failed read, never as an error in the view", async () => {
		const skills = vi.fn<NonNullable<WorkspaceActions["skills"]>>(() => {
			throw new Error("Conversation access changed.");
		});
		// A restored draft that names a skill reads the list while the view is built.
		const f = setup({ skills }, "Use /triage");
		await settle();
		expect(skills).toHaveBeenCalledOnce();
		f.type("/");
		await settle();
		expect(f.menu.hidden).toBe(true);
		expect(skills).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(11_000);
		skills.mockResolvedValueOnce(SKILLS);
		f.type("/t");
		await settle();
		expect(f.options().map((option) => option.name)[0]).toBe("/triage");
	});

	it("does not open inside a name already written, and closes when the field is disabled or replaced", async () => {
		const f = setup({ skills: vi.fn(async () => SKILLS) });
		f.type("/");
		await settle();
		f.field.value = "Use /monthly-vat-report now";
		f.field.setSelectionRange(13, 13);
		f.field.dispatchEvent(new Event("input", { bubbles: true }));
		expect(f.menu.hidden).toBe(true);
		// Arrow keys move the caret as usual there.
		expect(f.key("ArrowDown").defaultPrevented).toBe(false);
		f.type("Use /mon");
		expect(f.menu.hidden).toBe(false);
		// The draft is replaced (another tab, a send): the menu closes and never writes at old offsets.
		f.company.conversation(session.sessionId).set({ draft: "Something else" });
		await settle();
		expect(f.field.value).toBe("Something else");
		expect(f.menu.hidden).toBe(true);
		f.type("/mon");
		expect(f.menu.hidden).toBe(false);
		f.company.conversation(session.sessionId).set({ sending: true });
		await settle();
		expect(f.field.disabled).toBe(true);
		expect(f.menu.hidden).toBe(true);
	});

	it("closes the composer's other menu when the skills open", async () => {
		const f = setup({ skills: vi.fn(async () => SKILLS) });
		const more = f.view.el.querySelector<HTMLButtonElement>(".composer-more")!;
		more.click();
		const other = f.view.el.querySelector<HTMLElement>(".composer-menu")!;
		expect(other.hidden).toBe(false);
		f.type("/");
		await settle();
		expect(f.menu.hidden).toBe(false);
		expect(other.hidden).toBe(true);
	});

	it("marks skill names in written messages, never in code or links, once the list is known", async () => {
		let answer!: (skills: SkillSuggestion[]) => void;
		const skills = vi.fn(
			() =>
				new Promise<SkillSuggestion[]>((resolve) => {
					answer = resolve;
				}),
		);
		const items: TranscriptItem[] = [
			{
				kind: "member",
				id: id(84),
				sequence: 1,
				authorUserId: userA.id,
				text: "Please run /monthly-vat-report and /nope today",
				attachmentCount: 0,
				createdAt: timestamp,
			},
			{
				kind: "agent",
				id: id(85),
				sequence: 2,
				text: "Done with /monthly-vat-report. Next time call `/triage` or see [/triage](https://example.invalid) or /triage.",
				attachmentCount: 0,
				phase: "final",
				createdAt: timestamp,
				authorUserId: userA.id,
			},
		];
		const f = setup({ skills }, undefined, items);
		await settle();
		// Written messages that may name a skill read the list without a "/" being typed.
		expect(skills).toHaveBeenCalledOnce();
		expect(f.view.el.querySelectorAll(".message-skill")).toHaveLength(0);
		answer(SKILLS);
		await settle();
		const marked = (selector: string) =>
			[...f.view.el.querySelectorAll(`${selector} .message-skill`)].map((span) => span.textContent);
		expect(marked(".mine .bubble")).toEqual(["/monthly-vat-report"]);
		expect(marked(".from-agent .bubble")).toEqual(["/monthly-vat-report", "/triage"]);
		expect(f.view.el.querySelector(".from-agent code")?.textContent).toBe("/triage");
		expect(f.view.el.querySelector(".from-agent a .message-skill")).toBeNull();
		// The message text itself is unchanged, only marked.
		expect(f.view.el.querySelector(".mine .bubble")?.textContent).toBe(
			"Please run /monthly-vat-report and /nope today",
		);
		// A redraw marks the new nodes again, once.
		f.company.conversation(session.sessionId).set({
			projection: {
				items: [
					...items,
					{ ...items[0]!, id: id(86), sequence: 3, text: "And /customer-refund." },
				] as TranscriptItem[],
				hiddenCount: 0,
				lastSequence: 3,
			},
		});
		await settle();
		expect(marked(".mine .bubble")).toEqual(["/monthly-vat-report", "/customer-refund"]);
		expect(skills).toHaveBeenCalledOnce();
		// Later redraws of an open thread read nothing by themselves: only a typed "/" refreshes.
		vi.advanceTimersByTime(25_000);
		f.company.conversation(session.sessionId).set({
			projection: {
				items: [...items, { ...items[0]!, id: id(87), sequence: 4, text: "Also /triage." }] as TranscriptItem[],
				hiddenCount: 0,
				lastSequence: 4,
			},
		});
		await settle();
		expect(skills).toHaveBeenCalledOnce();
		expect(marked(".mine .bubble")).toEqual(["/monthly-vat-report", "/triage"]);
		f.type("/");
		await Promise.resolve();
		expect(skills).toHaveBeenCalledTimes(2);
	});

	it("marks a name only where it stands as a word, as the composer does", () => {
		const root = markdown("**done**/triage, /triage**bold**, `x`/triage and\n\n/triage (/weekly-report) /triage.");
		markSkillNames(root, new Set(["triage", "weekly-report"]));
		expect([...root.querySelectorAll(".message-skill")].map((span) => span.textContent)).toEqual([
			"/triage",
			"/triage",
		]);
		expect(root.textContent).toBe("done/triage, /triagebold, x/triage and/triage (/weekly-report) /triage.");
		// A line break inside a paragraph is a word break: a name at the start of a new line is a name.
		const lines = document.createElement("div");
		lines.append(...markdownBubbles("Done.\n/triage next"));
		markSkillNames(lines, new Set(["triage"]));
		expect(lines.querySelector("br")).not.toBeNull();
		expect([...lines.querySelectorAll(".message-skill")].map((span) => span.textContent)).toEqual(["/triage"]);
		// Marking again changes nothing.
		markSkillNames(root, new Set(["triage", "weekly-report"]));
		expect(root.querySelectorAll(".message-skill")).toHaveLength(2);
	});

	it("shares the field with the @ names: one list at a time, and each keeps the field's popup its own", async () => {
		const f = fixture();
		const roomId = id(79);
		const astrid = { ...staff, id: id(40), displayName: "Astrid" };
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			team: {
				...team,
				members: [
					{
						userId: userA.id,
						email: "a@example.invalid",
						displayName: "Jonas",
						role: "owner",
						joinedAt: timestamp,
					},
				],
			},
			staff: [staff, astrid],
			sessions: [{ ...session, title: "Launch", executionScope: { roomId } }],
			groups: {
				[roomId]: {
					roomId,
					sessionId: session.sessionId,
					environmentId: profileA.environmentId,
					version: 1,
					name: "Launch",
					purpose: "Plan the launch",
					status: "active",
					members: [
						{ kind: "member", id: userA.id },
						{ kind: "staff_agent", id: astrid.id },
					],
				},
			},
			loading: false,
		});
		vi.mocked(f.api.listMemberMentions).mockReset().mockResolvedValue([]);
		await company.refreshMentions();
		const view = new ConversationView(company, session.sessionId, { skills: vi.fn(async () => SKILLS) });
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		const field = view.el.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
		const names = view.el.querySelector<HTMLElement>(".mention-picker")!;
		const skills = view.el.querySelector<HTMLElement>(".skill-menu")!;
		const type = (text: string) => {
			field.focus();
			field.value = text;
			field.setSelectionRange(text.length, text.length);
			field.dispatchEvent(new Event("input", { bubbles: true }));
		};
		type("@As");
		await settle();
		expect(names.hidden).toBe(false);
		expect(skills.hidden).toBe(true);
		// Typing on in the name leaves the names' popup attributes alone.
		type("@Ast");
		expect(field.getAttribute("aria-controls")).toBe(names.id);
		expect(field.getAttribute("aria-activedescendant")).toBe(`${names.id}-0`);
		type("@Astrid /cust");
		await settle();
		expect(skills.hidden).toBe(false);
		expect(names.hidden).toBe(true);
		expect(field.getAttribute("aria-controls")).toBe(view.el.querySelector(".skill-list")?.id);
		type("@Ast");
		await settle();
		expect(skills.hidden).toBe(true);
		expect(names.hidden).toBe(false);
		expect(field.getAttribute("aria-controls")).toBe(names.id);
	});

	it("leaves the composer as it was without a skills adapter", () => {
		const f = setup({});
		expect(f.field.hasAttribute("aria-autocomplete")).toBe(false);
		f.type("/triage");
		expect(f.menu.hidden).toBe(true);
		expect(f.view.el.querySelector(".composer-field")?.classList.contains("has-skills")).toBe(false);
	});
});

describe("reading the skill list", () => {
	const LEDGER = "agents/ledger";
	/** A company folder where the fixture agent is agents/ledger, with skills of its own and the company's. */
	function company(tree: Record<string, string> = {}) {
		const fake = folderFake();
		fake.put(
			`${LEDGER}/agent.md`,
			writeAgentFile({
				id: staff.id,
				name: "Ledger",
				role: "Keeps the books",
				agentKind: "agent",
				status: "active",
				colour: null,
				figure: null,
				model: null,
				effort: null,
				instructions: "Keep the books.",
			}),
		);
		fake.mkdir(`${LEDGER}/skills`);
		for (const [path, text] of Object.entries(tree)) fake.put(path, text);
		// A file that is not text is unreadable here.
		const readFile = fake.folder.readFile.getMockImplementation()!;
		fake.folder.readFile.mockImplementation(async (...args) => {
			const bytes = await readFile(...args);
			if (new TextDecoder().decode(bytes) === "not text") throw new CloudMemberFolderError("not text");
			return bytes;
		});
		return fake;
	}
	const signal = () => new AbortController().signal;

	it("lists the agent's own skills, then the company's, with the descriptions agents read", async () => {
		const fake = company({
			[`${LEDGER}/skills/triage/SKILL.md`]:
				"---\nname: triage\ndescription: >-\n  Sort new\n  tickets.\n---\n\nSteps.\n",
			"skills/customer-refund/SKILL.md":
				'---\nname: customer-refund\ndescription: "Refund a customer."\n---\n\nSteps.\n',
			"skills/weekly-note.md": "---\ndescription: A flat skill file.\n---\nSteps.\n",
			// A folder and a flat file of one name: the folder is the skill.
			"skills/both/SKILL.md": "---\ndescription: From the folder.\n---\n",
			"skills/both.md": "---\ndescription: From the flat file.\n---\n",
			"skills/broken/SKILL.md": "not text",
			// A folder without its SKILL.md, and names that are not skill names, are not skills.
			"skills/empty/notes.txt": "not a skill",
			"skills/README.md": "Not a skill name.",
			"skills/Upper/SKILL.md": "---\ndescription: Not a skill name.\n---\n",
		});
		expect(await loadSkillSuggestions(fake.folder, staff.id, signal())).toEqual([
			{ name: "triage", description: "Sort new tickets.", scope: "agent" },
			{ name: "both", description: "From the folder.", scope: "company" },
			{ name: "broken", description: null, scope: "company" },
			{ name: "customer-refund", description: "Refund a customer.", scope: "company" },
			{ name: "weekly-note", description: "A flat skill file.", scope: "company" },
		]);
		expect(fake.folder.list).toHaveBeenCalledWith(`${LEDGER}/skills`, null, 100, expect.any(AbortSignal));
		expect(fake.folder.list).toHaveBeenCalledWith("skills", null, 100, expect.any(AbortSignal));
		// A group chat, or a thread without an agent, offers only the company's.
		fake.folder.list.mockClear();
		const companyOnly = await loadSkillSuggestions(fake.folder, null, signal());
		expect(companyOnly.map((skill) => skill.name)).toEqual(["both", "broken", "customer-refund", "weekly-note"]);
		expect(companyOnly.every((skill) => skill.scope === "company")).toBe(true);
		expect(fake.folder.list).toHaveBeenCalledExactlyOnceWith("skills", null, 100, expect.any(AbortSignal));
	});

	it("offers only the company's skills for an agent without a folder this member reads", async () => {
		const fake = company({ "skills/customer-refund/SKILL.md": "---\ndescription: Refund.\n---\n" });
		expect(await loadSkillSuggestions(fake.folder, id(99), signal())).toEqual([
			{ name: "customer-refund", description: "Refund.", scope: "company" },
		]);
		expect(fake.folder.list).toHaveBeenCalledExactlyOnceWith("skills", null, 100, expect.any(AbortSignal));
	});

	it("offers the company's skills when the agent's folder is closed, and fails on any other failed listing", async () => {
		const closed = company({
			"skills/customer-refund/SKILL.md": "---\ndescription: Refund.\n---\n",
			[`${LEDGER}/skills/triage/SKILL.md`]: "---\ndescription: Sort.\n---\n",
		});
		closed.deny(`${LEDGER}/skills`);
		expect(await loadSkillSuggestions(closed.folder, staff.id, signal())).toEqual([
			{ name: "customer-refund", description: "Refund.", scope: "company" },
		]);
		expect(closed.folder.list).toHaveBeenCalledWith(`${LEDGER}/skills`, null, 100, expect.any(AbortSignal));
		// Never "no skills" for a failed listing: the composer keeps its last list and reads again.
		const down = company();
		down.fail("skills");
		await expect(loadSkillSuggestions(down.folder, staff.id, signal())).rejects.toBeInstanceOf(
			CloudMemberFolderError,
		);
		// Neither is the company's library closed to this member "no skills".
		const denied = company();
		denied.deny("skills");
		await expect(loadSkillSuggestions(denied.folder, null, signal())).rejects.toBeInstanceOf(
			CloudMemberFolderAccessDenied,
		);
		// An outage of the agent's folder is not a closed folder: the agent's skills are not dropped quietly.
		const agentDown = company();
		agentDown.fail(`${LEDGER}/skills`);
		await expect(loadSkillSuggestions(agentDown.folder, staff.id, signal())).rejects.toThrow("unavailable");
	});

	it("lists every page of a library, and reads the descriptions of the first sixty", async () => {
		const tree: Record<string, string> = {};
		for (let index = 0; index <= 100; index++)
			tree[`skills/s-${String(index).padStart(3, "0")}/SKILL.md`] = `---\ndescription: Skill ${index}.\n---\n`;
		const fake = company(tree);
		const skills = await loadSkillSuggestions(fake.folder, null, signal());
		expect(skills).toHaveLength(101);
		expect(fake.folder.list.mock.calls.map(([parent, after]) => [parent, after])).toEqual([
			["skills", null],
			["skills", "skills/s-099"],
		]);
		expect(skills[0]).toEqual({ name: "s-000", description: "Skill 0.", scope: "company" });
		expect(skills[59]?.description).toBe("Skill 59.");
		// The rest are offered by name; their files are not read.
		expect(skills[60]).toEqual({ name: "s-060", description: null, scope: "company" });
		expect(skills[100]).toEqual({ name: "s-100", description: null, scope: "company" });
		expect(fake.folder.read).toHaveBeenCalledTimes(60);
	});

	it("stops when the reader's company closes, and never offers a partial list", async () => {
		const fake = company({ "skills/customer-refund/SKILL.md": "---\ndescription: Refund.\n---\n" });
		const stop = new AbortController();
		const read = fake.folder.read.getMockImplementation()!;
		fake.folder.read.mockImplementation(async (...args) => {
			stop.abort();
			return read(...args);
		});
		await expect(loadSkillSuggestions(fake.folder, null, stop.signal)).rejects.toThrow();
	});

	it("shares one read among a company's threads for a minute, and forgets a failed one", async () => {
		const lists = new SkillLists();
		const read = vi.fn<() => Promise<SkillSuggestion[]>>().mockResolvedValue(SKILLS);
		const [first, second] = [lists.get(staff.id, read), lists.get(staff.id, read)];
		expect(await first).toBe(await second);
		expect(read).toHaveBeenCalledOnce();
		// Another agent's thread reads its own list.
		await lists.get(null, read);
		expect(read).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(61_000);
		read.mockRejectedValueOnce(new Error("unavailable"));
		await expect(lists.get(staff.id, read)).rejects.toThrow("unavailable");
		await settle();
		expect(await lists.get(staff.id, read)).toBe(SKILLS);
		expect(read).toHaveBeenCalledTimes(4);
	});
});
