// @vitest-environment jsdom

import type { CloudMemberFolderOp } from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import {
	INTERFACE_CHANGE_SCHEMA,
	type InterfaceChange,
	interfaceChangeSubjects,
	parseInterfaceChange,
} from "../src/cloud/interface-changes.ts";
import { projectTranscript } from "../src/cloud/transcript.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import { interfaceChangeText, renderInterfaceChangeLine } from "../src/ui/interface-change-line.ts";
import {
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

const V = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function change(changes: InterfaceChange["changes"], overrides: Partial<InterfaceChange> = {}): InterfaceChange {
	return { commitId: id(60), seq: 7, runId: id(61), staffAgentId: staff.id, changes, ...overrides };
}

function path(unit: number, op: CloudMemberFolderOp, pathValue: string, priorVersion: string | null = null) {
	return {
		unit,
		op,
		kind: op === "mkdir" ? ("folder" as const) : ("file" as const),
		path: pathValue,
		version: V(unit),
		priorVersion,
	};
}

function body(value: InterfaceChange): HostedSessionEvent["body"] {
	return JSON.parse(JSON.stringify({ schema: INTERFACE_CHANGE_SCHEMA, ...value })) as HostedSessionEvent["body"];
}

describe("an interface change's note", () => {
	const made = change([
		path(1, "mkdir", "QorperaOS/interfaces/Leads"),
		path(2, "write", "QorperaOS/interfaces/Leads/interface.toml"),
		path(3, "write", "QorperaOS/interfaces/order.md", V(90)),
	]);

	it("reads a well-formed note", () => {
		expect(parseInterfaceChange(body(made))).toEqual(made);
	});

	it.each([
		["another schema", { schema: "qorpera.peer-link/v1" }],
		["no changes", { changes: [] }],
		["a run that is not an id", { runId: "run" }],
		["no seq", { seq: 0 }],
		["a path outside interfaces/ and tables/", { changes: [path(1, "write", "QorperaOS/agents/sales/agent.md")] }],
		["a path outside QorperaOS/", { changes: [path(1, "write", "interfaces/a/b.md")] }],
		["the interfaces folder itself", { changes: [path(1, "write", "QorperaOS/interfaces")] }],
		["a path that climbs", { changes: [path(1, "write", "QorperaOS/interfaces/../agents/sales/agent.md")] }],
		["an unknown op", { changes: [{ ...path(1, "write", "QorperaOS/interfaces/a/b.md"), op: "rename" }] }],
		["a unit 0", { changes: [path(0, "write", "QorperaOS/interfaces/a/b.md")] }],
		[
			"a version that is not an id",
			{ changes: [{ ...path(1, "write", "QorperaOS/interfaces/a/b.md"), version: "v1" }] },
		],
		[
			"no prior version",
			{ changes: [{ ...path(1, "write", "QorperaOS/interfaces/a/b.md"), priorVersion: undefined }] },
		],
	])("refuses %s", (_label, overrides) => {
		expect(parseInterfaceChange({ ...(body(made) as Record<string, unknown>), ...overrides })).toBeNull();
	});

	it("shows in the transcript as one item, and a malformed one not at all", () => {
		const note = (sequence: number, value: HostedSessionEvent["body"]): HostedSessionEvent => ({
			sessionId: session.sessionId,
			sequence,
			eventId: id(100 + sequence),
			eventType: "session_info",
			actorUserId: userA.id,
			eventHash: "a".repeat(64),
			createdAt: timestamp,
			body: value,
		});
		const projection = projectTranscript([
			note(1, body(made)),
			note(2, { ...(body(made) as Record<string, unknown>), changes: [] } as HostedSessionEvent["body"]),
		]);
		expect(projection.items).toEqual([
			{ kind: "interface_change", id: id(101), sequence: 1, change: made, createdAt: timestamp },
		]);
		expect(projection.lastSequence).toBe(2);
	});

	it("names what it touched, each interface and table once, in the note's order", () => {
		const touched = change([
			path(1, "mkdir", "QorperaOS/interfaces/Leads"),
			path(2, "write", "QorperaOS/interfaces/Leads/interface.toml"),
			path(3, "write", "qorperaos/Tables/Clients/table.toml", V(91)),
			path(4, "write", "QorperaOS/interfaces/order.md", V(90)),
			path(5, "delete", "QorperaOS/tables/old", V(92)),
			path(6, "move_out", "QorperaOS/interfaces/Offers", V(93)),
			path(7, "write", "QorperaOS/interfaces/leads/view.html"),
		]);
		expect(interfaceChangeSubjects(touched)).toEqual({
			subjects: [
				{ kind: "interface", name: "Leads", how: "made" },
				{ kind: "table", name: "Clients", how: "changed" },
				{ kind: "table", name: "old", how: "removed" },
				{ kind: "interface", name: "Offers", how: "removed" },
			],
			order: true,
		});
	});
});

describe("an interface change in plain words", () => {
	it("says what it made, changed and deleted, each by its title when it has one", () => {
		const text = interfaceChangeText(
			change([
				path(1, "mkdir", "QorperaOS/interfaces/Leads"),
				path(2, "write", "QorperaOS/tables/clients/table.toml", V(91)),
				path(3, "write", "QorperaOS/interfaces/order.md", V(90)),
				path(4, "delete", "QorperaOS/tables/old", V(92)),
				path(5, "delete", "QorperaOS/interfaces/offers", V(93)),
			]),
			(subject) =>
				subject.name === "Leads" ? "  Leads\n board " : subject.name === "clients" ? "Clients" : undefined,
		);
		expect(text).toBe(
			"Made the interface “Leads board”, changed the table “Clients” and the order of the interfaces, and deleted " +
				"the table “old” and the interface “offers”",
		);
	});

	it("names four and counts the rest", () => {
		const many = change(
			["a", "b", "c", "d", "e", "f"].map((name, index) => path(index + 1, "mkdir", `QorperaOS/interfaces/${name}`)),
		);
		expect(interfaceChangeText(many, () => undefined)).toBe(
			"Made the interface “a”, the interface “b”, the interface “c”, and the interface “d” and 2 other changes",
		);
		const five = change(
			["a", "b", "c", "d", "e"].map((name, index) => path(index + 1, "mkdir", `QorperaOS/tables/${name}`)),
		);
		expect(interfaceChangeText(five, () => undefined)).toMatch(/and 1 other change$/);
	});

	it("draws one line without file paths", () => {
		const leads = change([path(1, "mkdir", "QorperaOS/interfaces/leads")]);
		const line = renderInterfaceChangeLine(leads, "Made the interface “Leads”");
		expect(line.getAttribute("role")).toBe("note");
		expect(line.dataset.interfaceChange).toBe(id(60));
		expect(line.querySelector(".interface-change-text")?.textContent).toBe("Made the interface “Leads”");
		expect(line.querySelector("button")).toBeNull();
		expect(line.textContent).not.toContain("interfaces/");
	});
});

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.stubGlobal("innerWidth", 1280);
	stubFigureMotion();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("an interface change in the agent's thread", () => {
	const leads = change([
		path(1, "mkdir", "QorperaOS/interfaces/leads"),
		path(2, "write", "QorperaOS/interfaces/leads/interface.toml"),
	]);
	const note = (value: InterfaceChange, sequence = 5): HostedSessionEvent => ({
		sessionId: session.sessionId,
		sequence,
		eventId: id(100 + sequence),
		eventType: "session_info",
		actorUserId: userA.id,
		eventHash: "a".repeat(64),
		createdAt: timestamp,
		body: body(value),
	});

	it("renders as one note line in the conversation", async () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			team,
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		company.conversation(session.sessionId, false);
		const view = new ConversationView(company, session.sessionId, {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([note(leads)]);
		await company.loadConversation(session.sessionId);
		await settle();
		const line = view.el.querySelector<HTMLElement>(`[data-interface-change="${id(60)}"]`)!;
		expect(line.querySelector(".interface-change-text")?.textContent).toBe("Made the interface “leads”");
		expect(line.textContent).not.toContain("interfaces/");
		expect(line.querySelector("button")).toBeNull();
	});
});
