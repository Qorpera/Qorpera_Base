// @vitest-environment jsdom
import type {
	CloudMemberCompanyEdit,
	CloudMemberCompanyFileClient,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { createConversationStarter } from "../src/app/start-conversation.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
});

const observed: NativeExecutionConnections = {
	computeIdentity: {
		computeIdentityId: id(80),
		ownershipKind: "member",
		ownerUserId: userA.id,
		displayName: "My compute",
		templateKey: "member",
		templateVersion: "1",
		capabilities: ["agent_turn"],
		policy: {},
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
	},
	connections: [
		{
			connectionId: id(90),
			clientConnectionId: id(190),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "subscription",
			consentVersion: "1",
			consentedAt: timestamp,
			connectionStatus: "active",
			sponsorBindingId: id(100),
			sponsorVersion: 1,
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 1 },
		},
	],
};

function setup() {
	const f = fixture();
	const write = vi.fn<SessionInputWriter>(async () => ({ inputId: id(120) }));
	const company = new CompanyController(f.api, profileA, userA.id, write);
	const other = { ...staff, id: id(20), displayName: "Other agent" };
	company.store.set({ team, staff: [staff, other], sessions: [], loading: false });
	cleanup.push(() => company.stop());
	let document: { path: string; text: string } | undefined;
	const editor = {
		read: vi.fn(async (path: string) =>
			path === "organization/rooms"
				? { path, kind: "directory", version: id(109), text: "" }
				: document
					? { path, kind: "file", version: id(110), text: document.text }
					: { path, kind: "absent", version: null, text: "" },
		),
		edit: vi.fn(async (input: CloudMemberCompanyEdit) => {
			if (input.operation === "write") document = input;
			return { commandId: id(111), state: "review_required", result: null };
		}),
		review: vi.fn(async () => ({
			commandId: id(111),
			state: "applied",
			result: { snapshotId: id(112), version: id(110) },
		})),
	};
	vi.mocked(f.api.listSessions).mockImplementation(async () =>
		document
			? [{ ...session, executionScope: { roomId: (JSON.parse(document.text) as { roomId: string }).roomId } }]
			: [{ ...session, staffAgentId: staff.id, executionScope: { roomId: id(130), agentThread: true } }],
	);
	vi.spyOn(f.api, "agentThread").mockResolvedValue({
		roomId: id(130),
		sessionId: session.sessionId,
		staffAgentId: staff.id,
		status: "active",
	});
	const listConnections = vi.fn(async () => observed);
	const selectSessionAccount = vi.fn(async (): Promise<string | undefined> => id(90));
	const refreshAccountMetadata = vi.fn(async (): Promise<void> => undefined);
	const current = vi.fn();
	const getEditor = vi.fn(async () => editor as unknown as CloudMemberCompanyFileClient);
	const start = createConversationStarter({
		company,
		native: { listConnections, selectSessionAccount, refreshAccountMetadata },
		editor: getEditor,
		current,
		send: (sessionId, text, signal) => company.sendPrompt(sessionId, text, signal),
	});
	return {
		...f,
		company,
		editor,
		getEditor,
		listConnections,
		selectSessionAccount,
		refreshAccountMetadata,
		current,
		start,
		write,
		other,
		signal: new AbortController().signal,
	};
}

describe("starting a conversation on first send", () => {
	it("refreshes account usage before creating a room or selecting its first sponsor", async () => {
		const f = setup();
		const pending = deferred<void>();
		f.refreshAccountMetadata.mockReturnValue(pending.promise);
		const start = f.start([staff.id], "Hello", f.signal);
		await settle();
		expect(f.listConnections).not.toHaveBeenCalled();
		expect(f.api.agentThread).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
		pending.resolve();
		await start;
		expect(f.selectSessionAccount).toHaveBeenCalledTimes(1);
		expect(f.write).toHaveBeenCalledTimes(1);
	});
	it("keeps the first message unsent when usage cannot be refreshed", async () => {
		const f = setup();
		f.refreshAccountMetadata.mockRejectedValue(new Error("Usage unavailable"));
		await expect(f.start([staff.id], "Hello", f.signal)).rejects.toThrow("Usage unavailable");
		expect(f.api.agentThread).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
	});
	it("creates the missing rooms directory before the first governed room document", async () => {
		const f = setup();
		f.editor.read.mockResolvedValueOnce({ path: "organization/rooms", kind: "absent", version: null, text: "" });
		expect(await f.start([staff.id, f.other.id], "Hello group", f.signal)).toBe(session.sessionId);
		expect(f.editor.edit.mock.calls.map(([edit]) => edit.operation)).toEqual(["mkdir", "write"]);
		expect(f.editor.edit.mock.calls[0]?.[0]).toMatchObject({ path: "organization/rooms", expectedVersion: null });
		expect(f.editor.review).toHaveBeenCalledTimes(2);
	});
	it("creates a governed room containing exactly the member and selected agents, then sends to its session", async () => {
		const f = setup();
		expect(await f.start([staff.id, f.other.id, staff.id], "Hello group", f.signal)).toBe(session.sessionId);
		const edit = f.editor.edit.mock.calls[0]![0];
		if (edit.operation !== "write") throw new Error("Expected room write");
		const document = JSON.parse(edit.text) as { roomId: string; members: unknown[] };
		expect(edit.path).toBe(`organization/rooms/${document.roomId}.json`);
		expect(document.members).toEqual([
			{ kind: "member", id: userA.id },
			{ kind: "staff_agent", id: staff.id },
			{ kind: "staff_agent", id: f.other.id },
		]);
		expect(f.editor.review).toHaveBeenCalledOnce();
		expect(f.write).toHaveBeenCalledWith(
			session.sessionId,
			expect.any(String),
			"Hello group",
			expect.any(AbortSignal),
			[],
			expect.objectContaining({ sponsorBindingId: id(100) }),
			{ roomId: document.roomId, environmentId: profileA.environmentId, agentThread: false },
		);
		expect(f.company.conversation(session.sessionId, false).get().draft).toBe("");
	});
	it("uses the canonical agent thread for one recipient without writing a room", async () => {
		const f = setup();
		expect(await f.start([staff.id], "Hello", f.signal)).toBe(session.sessionId);
		expect(f.api.agentThread).toHaveBeenCalledWith(profileA.environmentId, staff.id);
		expect(f.getEditor).not.toHaveBeenCalled();
		expect(f.write).toHaveBeenCalledOnce();
	});
	it.each(["agent", "group"])(
		"uses the server-selected account and current binding for the first %s message",
		async (kind) => {
			const f = setup();
			const selected = {
				...observed.connections[0]!,
				connectionId: id(91),
				sponsorBindingId: id(101),
				sponsorVersion: 2,
			};
			f.listConnections.mockResolvedValueOnce(observed).mockResolvedValue({
				...observed,
				connections: [...observed.connections, selected],
			});
			f.selectSessionAccount.mockImplementation(async () => {
				expect(f.company.store.get().sessions.some((item) => item.sessionId === session.sessionId)).toBe(true);
				return selected.connectionId;
			});
			await f.start(kind === "agent" ? [staff.id] : [staff.id, f.other.id], "Hello", f.signal);
			expect(f.selectSessionAccount).toHaveBeenCalledExactlyOnceWith(session.sessionId, expect.any(AbortSignal));
			expect(f.listConnections.mock.invocationCallOrder[1]).toBeGreaterThan(
				f.selectSessionAccount.mock.invocationCallOrder[0]!,
			);
			expect(f.write.mock.calls[0]?.[5]).toMatchObject({
				connectionId: id(91),
				sponsorBindingId: id(101),
				sponsorVersion: 2,
			});
		},
	);
	it.each(["unavailable", "failed"])(
		"does not fall back to the first account when server selection is %s",
		async (outcome) => {
			const f = setup();
			if (outcome === "unavailable") f.selectSessionAccount.mockResolvedValue(undefined);
			else f.selectSessionAccount.mockRejectedValue(new Error("Selection failed"));
			await expect(f.start([staff.id], "Keep draft", f.signal)).rejects.toThrow();
			expect(f.write).not.toHaveBeenCalled();
			expect(f.company.conversation(session.sessionId, false).get().executionSponsor).toBeUndefined();
		},
	);
	it.each(["cancelled", "access lost", "draft changed", "send began"])(
		"rechecks conversation authority after pending selection when %s",
		async (change) => {
			const f = setup();
			const selection = deferred<string | undefined>();
			const view = new AbortController();
			f.selectSessionAccount.mockReturnValueOnce(selection.promise);
			const result = f.start([staff.id], "New draft", view.signal);
			await settle();
			expect(f.selectSessionAccount).toHaveBeenCalledOnce();
			const conversation = f.company.conversation(session.sessionId, false);
			if (change === "cancelled") view.abort();
			else if (change === "access lost") f.company.store.set({ accessLost: true });
			else if (change === "draft changed") conversation.set({ draft: "Earlier draft" });
			else conversation.set({ sending: true });
			selection.resolve(id(90));
			await expect(result).rejects.toThrow();
			expect(f.write).not.toHaveBeenCalled();
			if (change === "draft changed") expect(conversation.get().draft).toBe("Earlier draft");
		},
	);
	it.each(["text", "images"])(
		"preserves an existing agent's unsent %s without sending it from the new composer",
		async (kind) => {
			const f = setup();
			const existing = f.company.conversation(session.sessionId, false);
			const attachments =
				kind === "images" ? [new File(["private image"], "private.png", { type: "image/png" })] : [];
			const draft = kind === "text" ? "Earlier draft" : "";
			existing.set({ draft, attachments });
			await expect(f.start([staff.id], "New draft", f.signal)).rejects.toThrow("unsent draft");
			expect(existing.get().draft).toBe(draft);
			expect(existing.get().attachments).toBe(attachments);
			expect(f.write).not.toHaveBeenCalled();
		},
	);
	it("preserves the first message and exact retry identity after an uncertain send", async () => {
		const f = setup();
		f.write.mockRejectedValueOnce(new Error("Lost receipt"));
		expect(await f.start([staff.id, f.other.id], "Keep this", f.signal)).toBe(session.sessionId);
		const conversation = f.company.conversation(session.sessionId, false);
		expect(conversation.get()).toMatchObject({
			draft: "Keep this",
			sendError: "Lost receipt",
			retrySend: { text: "Keep this" },
		});
		const request = f.write.mock.calls[0];
		expect(await f.company.sendPrompt(session.sessionId, "Keep this", f.signal)).toBe(true);
		expect(f.write.mock.calls[1]?.slice(0, 3)).toEqual(request?.slice(0, 3));
		expect(f.editor.edit).toHaveBeenCalledOnce();
	});
	it("recovers the same room when session discovery fails after creation", async () => {
		const f = setup();
		vi.mocked(f.api.listSessions).mockRejectedValueOnce(new Error("Unavailable"));
		await expect(f.start([staff.id, f.other.id], "Keep this", f.signal)).rejects.toThrow("still opening");
		expect(f.write).not.toHaveBeenCalled();
		expect(await f.start([f.other.id, staff.id], "Keep this", f.signal)).toBe(session.sessionId);
		expect(f.editor.edit).toHaveBeenCalledOnce();
		expect(f.editor.read.mock.calls[3]?.[0]).toBe(f.editor.read.mock.calls[1]?.[0]);
	});
	it("recovers an applied room after its approval response was lost", async () => {
		const f = setup();
		f.editor.review.mockRejectedValueOnce(new Error("Lost approval response"));
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Lost approval response");
		expect(await f.start([staff.id, f.other.id], "Hello", f.signal)).toBe(session.sessionId);
		expect(f.editor.edit).toHaveBeenCalledOnce();
	});
	it("rejects unavailable model accounts before creating a room", async () => {
		const f = setup();
		f.listConnections.mockResolvedValueOnce({ connections: [] });
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Connect a model account");
		expect(f.getEditor).not.toHaveBeenCalled();
	});
	it("rechecks recipients and company access after account discovery", async () => {
		const f = setup();
		const account = deferred<NativeExecutionConnections>();
		f.listConnections.mockReturnValueOnce(account.promise);
		const result = f.start([staff.id, f.other.id], "Hello", f.signal);
		f.company.store.set({ staff: [staff] });
		account.resolve(observed);
		await expect(result).rejects.toThrow("Choose active agents");
		expect(f.getEditor).not.toHaveBeenCalled();
	});
	it("does not create a room when contributor authority cannot approve it", async () => {
		const f = setup();
		f.company.store.set({
			team: { ...team, role: "contributor", capabilities: { ...team.capabilities, authorize: false } },
		});
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Only an owner or admin");
		expect(f.listConnections).not.toHaveBeenCalled();
	});
	it("keeps one preparation in flight and cancels before creating a room when the draft closes", async () => {
		const f = setup();
		const account = deferred<NativeExecutionConnections>();
		const view = new AbortController();
		f.listConnections.mockReturnValueOnce(account.promise);
		const result = f.start([staff.id, f.other.id], "Hello", view.signal);
		await expect(f.start([staff.id, f.other.id], "Hello", view.signal)).rejects.toThrow("Wait for this conversation");
		view.abort();
		account.resolve(observed);
		await expect(result).rejects.toThrow();
		expect(f.getEditor).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
	});
});
