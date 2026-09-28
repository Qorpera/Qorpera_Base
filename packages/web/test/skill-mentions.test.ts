// @vitest-environment jsdom

import type { CloudMemberCompanyFileClient } from "@qorpera/cloud-client/cloud-member-company-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { loadSkillSuggestions, type SkillSuggestion } from "../src/cloud/skills.ts";
import { fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

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

function setup(actions: WorkspaceActions = {}, draft?: string) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	if (draft !== undefined) company.conversation(session.sessionId).set({ draft });
	const view = new ConversationView(company, session.sessionId, actions);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const field = view.el.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
	const menu = view.el.querySelector<HTMLElement>(".skill-menu")!;
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
	return { ...f, company, view, field, menu, type, key, options };
}

describe("calling a skill from the composer", () => {
	it("offers the conversation's skills after a slash and writes the picked name in blue", async () => {
		let answer!: (skills: SkillSuggestion[]) => void;
		const skills = vi.fn(() => new Promise<SkillSuggestion[]>((resolve) => (answer = resolve)));
		const sendMessage = vi.fn().mockResolvedValue(true);
		const f = setup({ skills, sendMessage });
		expect(f.field.getAttribute("aria-autocomplete")).toBe("list");
		expect(f.field.getAttribute("aria-controls")).toBe(f.menu.id);
		f.type("Please /");
		// The list is read once, for this agent's thread: its own skills and the company's.
		expect(skills).toHaveBeenCalledExactlyOnceWith(staff.id, expect.any(AbortSignal));
		expect(f.menu.hidden).toBe(false);
		expect(f.menu.getAttribute("aria-busy")).toBe("true");
		expect(f.menu.querySelectorAll(".skeleton")).not.toHaveLength(0);
		answer(SKILLS);
		await settle();
		expect(f.menu.hasAttribute("aria-busy")).toBe(false);
		expect(f.options()).toEqual([
			{ name: "/triage", scope: staff.displayName, selected: true },
			{ name: "/customer-refund", scope: "Company", selected: false },
			{ name: "/monthly-vat-report", scope: "Company", selected: false },
		]);
		expect(f.field.getAttribute("aria-activedescendant")).toBe(`${f.menu.id}-0`);
		f.type("Please /RE");
		expect(f.options().map((option) => option.name)).toEqual(["/customer-refund", "/monthly-vat-report"]);
		expect(f.key("ArrowDown").defaultPrevented).toBe(true);
		expect(f.options()[1]?.selected).toBe(true);
		expect(f.field.getAttribute("aria-activedescendant")).toBe(`${f.menu.id}-1`);
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
		expect(roomSkills).toHaveBeenCalledExactlyOnceWith(null, expect.any(AbortSignal));
	});

	it("says there are no skills yet, closes after a failed read and tries again only after a pause", async () => {
		const skills = vi.fn<NonNullable<WorkspaceActions["skills"]>>().mockResolvedValueOnce([]);
		const f = setup({ skills });
		f.type("/");
		await settle();
		expect(f.menu.textContent).toBe("No skills yet. Agents save skills as they learn how the company works.");
		expect(f.options()).toEqual([]);
		// A name typed with no skill to match closes the menu.
		f.type("/x");
		expect(f.menu.hidden).toBe(true);
		// A minute later the list is read again; this time the read fails.
		vi.advanceTimersByTime(61_000);
		skills.mockRejectedValueOnce(new Error("Company File unavailable"));
		f.type("/");
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
		expect(skills).toHaveBeenCalledTimes(3);
		await settle();
		expect(f.options().map((option) => option.name)).toEqual(["/triage", "/customer-refund", "/monthly-vat-report"]);
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
	function files(tree: Record<string, string | null>, failing: string[] = []) {
		const entries = Object.keys(tree);
		const folders = new Set(
			entries.flatMap((path) =>
				path
					.split("/")
					.slice(0, -1)
					.map((_, index, parts) => parts.slice(0, index + 1).join("/")),
			),
		);
		const list = vi.fn(async (path: string) => {
			if (failing.includes(path)) throw new Error("Company File listing refused");
			const children = new Map<string, "file" | "directory">();
			for (const folder of folders)
				if (folder.startsWith(`${path}/`) && !folder.slice(path.length + 1).includes("/"))
					children.set(folder, "directory");
			for (const file of entries)
				if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")) children.set(file, "file");
			return {
				snapshotId: id(70),
				hasMore: false,
				nextAfter: null,
				items: [...children.entries()]
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.map(([child, kind]) => ({ path: child, version: id(71), kind, bytes: kind === "file" ? 1 : null })),
			};
		});
		const read = vi.fn(async (path: string) => {
			const text = tree[path];
			if (text === null) throw new Error("This viewer supports UTF-8 text files only");
			return text === undefined
				? { path, version: null, kind: "absent" as const, executable: false, text: "" }
				: { path, version: id(72), kind: "file" as const, executable: false, text };
		});
		return { list, read } as unknown as CloudMemberCompanyFileClient & { list: typeof list; read: typeof read };
	}

	it("lists the agent's own skills, then the company's, with the descriptions agents read", async () => {
		const client = files({
			[`agents/${staff.id}/skills/triage/SKILL.md`]:
				"---\nname: triage\ndescription: >-\n  Sort new\n  tickets.\n---\n\nSteps.\n",
			"skills/customer-refund/SKILL.md":
				'---\nname: customer-refund\ndescription: "Refund a customer."\n---\n\nSteps.\n',
			"skills/weekly-note.md": "---\ndescription: A flat skill file.\n---\nSteps.\n",
			"skills/broken/SKILL.md": null,
			"skills/empty/notes.txt": "not a skill",
			"skills/README.md": "Not a skill name.",
		});
		expect(await loadSkillSuggestions(client, staff.id, new AbortController().signal)).toEqual([
			{ name: "triage", description: "Sort new tickets.", scope: "agent" },
			{ name: "broken", description: null, scope: "company" },
			{ name: "customer-refund", description: "Refund a customer.", scope: "company" },
			{ name: "weekly-note", description: "A flat skill file.", scope: "company" },
		]);
		// A group chat, or a thread without an agent, offers only the company's.
		const company = await loadSkillSuggestions(client, null, new AbortController().signal);
		expect(company.every((skill) => skill.scope === "company")).toBe(true);
	});

	it("offers the other library when one cannot be listed", async () => {
		const client = files({ "skills/customer-refund/SKILL.md": "---\ndescription: Refund.\n---\n" }, [
			`agents/${staff.id}/skills`,
		]);
		expect(await loadSkillSuggestions(client, staff.id, new AbortController().signal)).toEqual([
			{ name: "customer-refund", description: "Refund.", scope: "company" },
		]);
	});
});
