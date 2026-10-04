// @vitest-environment jsdom
import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { createConversationStarter } from "../src/app/start-conversation.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import { UUID_PATTERN } from "../src/cloud/parse.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

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

/** The group chat's folder the two fixture agents get: its name is theirs, joined. */
const GROUP = "agents/groups/fixture-agent-other-agent";

function setup() {
	const f = fixture();
	const write = vi.fn<SessionInputWriter>(async () => ({ inputId: id(120) }));
	const company = new CompanyController(f.api, profileA, userA.id, write);
	const other = { ...staff, id: id(20), displayName: "Other agent" };
	company.store.set({ team, staff: [staff, other], sessions: [], loading: false });
	cleanup.push(() => company.stop());
	const fake = folderFake();
	// The commit's hook opens the room and its conversation for each group.md.
	vi.mocked(f.api.listSessions).mockImplementation(async () => {
		const room = fake.stateFolders().groups[0];
		return room
			? [{ ...session, executionScope: { roomId: room.roomId } }]
			: [{ ...session, staffAgentId: staff.id, executionScope: { roomId: id(130), agentThread: true } }];
	});
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
	const folder = vi.fn((_signal: AbortSignal) => fake.folder);
	const start = createConversationStarter({
		company,
		native: { listConnections, selectSessionAccount, refreshAccountMetadata },
		folder,
		current,
		send: (sessionId, text, signal) => company.sendPrompt(sessionId, text, signal),
	});
	return {
		...f,
		company,
		fake,
		folder,
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

function groupFile(fake: ReturnType<typeof folderFake>, path = `${GROUP}/group.md`) {
	const parsed = parseCompanyStateFile(path, fake.text(path) ?? "");
	if (!parsed?.ok || parsed.file.kind !== "group") throw new Error(`${path} does not parse`);
	return parsed.file;
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
	it("creates a group chat folder with exactly the member and the selected agents, then sends to its session", async () => {
		const f = setup();
		expect(await f.start([staff.id, f.other.id, staff.id], "Hello group", f.signal)).toBe(session.sessionId);
		expect(f.fake.commits).toHaveLength(1);
		const file = groupFile(f.fake);
		expect(f.fake.commits[0]).toEqual({
			operationKey: `web:room-create:${file.id}:fixture-agent-other-agent`,
			units: [
				{
					op: "new_folder",
					path: GROUP,
					contents: [{ path: "group.md", kind: "file", text: f.fake.text(`${GROUP}/group.md`) }],
				},
			],
		});
		expect(file).toEqual({
			kind: "group",
			id: expect.stringMatching(UUID_PATTERN),
			name: "Fixture agent, Other agent",
			subtitle: null,
			agents: [staff.id, f.other.id],
			people: [userA.id],
			purpose: "A group conversation with the selected agents.",
		});
		expect(f.write).toHaveBeenCalledWith(
			session.sessionId,
			expect.any(String),
			"Hello group",
			expect.any(AbortSignal),
			[],
			expect.objectContaining({ sponsorBindingId: id(100) }),
			{ roomId: file.id, environmentId: profileA.environmentId, agentThread: false, images: false },
		);
		expect(f.company.conversation(session.sessionId, false).get().draft).toBe("");
	});
	it("takes the next free handle when a group chat with the same name exists", async () => {
		const f = setup();
		f.fake.mkdir(GROUP);
		await f.start([staff.id, f.other.id], "Hello group", f.signal);
		expect(f.fake.commits[0]?.units[0]).toMatchObject({ op: "new_folder", path: `${GROUP}-2` });
		expect(groupFile(f.fake, `${GROUP}-2/group.md`).agents).toEqual([staff.id, f.other.id]);
	});
	it("uses the canonical agent thread for one recipient without writing a room", async () => {
		const f = setup();
		expect(await f.start([staff.id], "Hello", f.signal)).toBe(session.sessionId);
		expect(f.api.agentThread).toHaveBeenCalledWith(profileA.environmentId, staff.id);
		expect(f.folder).not.toHaveBeenCalled();
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
		expect(f.fake.commits).toHaveLength(1);
	});
	it("recovers the same room when session discovery fails after creation", async () => {
		const f = setup();
		vi.mocked(f.api.listSessions).mockRejectedValueOnce(new Error("Unavailable"));
		await expect(f.start([staff.id, f.other.id], "Keep this", f.signal)).rejects.toThrow("still opening");
		expect(f.write).not.toHaveBeenCalled();
		const room = groupFile(f.fake).id;
		// The same recipients, in another order, are the same draft: its group chat is found, not made again.
		expect(await f.start([f.other.id, staff.id], "Keep this", f.signal)).toBe(session.sessionId);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.children("agents/groups")).toEqual([GROUP]);
		expect(f.write.mock.calls[0]?.[6]).toMatchObject({ roomId: room });
	});
	it("finds the group chat a lost answer created instead of creating a second one", async () => {
		const f = setup();
		f.fake.loseAnswer();
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Failed to fetch");
		expect(await f.start([staff.id, f.other.id], "Hello", f.signal)).toBe(session.sessionId);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.children("agents/groups")).toEqual([GROUP]);
	});
	it("sends the same change set again when the first never reached the core", async () => {
		const f = setup();
		f.fake.failCommit();
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Failed to fetch");
		expect(await f.start([staff.id, f.other.id], "Hello", f.signal)).toBe(session.sessionId);
		expect(f.fake.commits).toHaveLength(2);
		expect(f.fake.commits[1]).toEqual(f.fake.commits[0]);
	});
	it("says the group chat was not created, with the hook's problems, and keeps the message", async () => {
		const f = setup();
		f.fake.answer("refused", "hook", ["an agent in it is archived"]);
		const error = await f.start([staff.id, f.other.id], "Hello", f.signal).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((error as Error).message).toBe(
			"The group chat could not be created. Your message is still here: an agent in it is archived.",
		);
		expect(f.write).not.toHaveBeenCalled();
		expect(f.fake.has(GROUP)).toBe(false);
	});
	it("makes a new group chat on the next try after a refusal, never a replay of the refused one", async () => {
		const f = setup();
		f.fake.answer("refused", "hook", ["try again later"]);
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toBeInstanceOf(
			WebCompanyFolderRejectedError,
		);
		expect(await f.start([staff.id, f.other.id], "Hello", f.signal)).toBe(session.sessionId);
		const [refused, created] = f.fake.commits;
		expect(created?.operationKey).not.toBe(refused?.operationKey);
		expect(created?.operationKey).toBe(`web:room-create:${groupFile(f.fake).id}:fixture-agent-other-agent`);
		expect(f.write).toHaveBeenCalledOnce();
	});
	it("rejects unavailable model accounts before creating a room", async () => {
		const f = setup();
		f.listConnections.mockResolvedValueOnce({ connections: [] });
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("Connect a model account");
		expect(f.folder).not.toHaveBeenCalled();
	});
	it("rechecks recipients and company access after account discovery", async () => {
		const f = setup();
		const account = deferred<NativeExecutionConnections>();
		f.listConnections.mockReturnValueOnce(account.promise);
		const result = f.start([staff.id, f.other.id], "Hello", f.signal);
		f.company.store.set({ staff: [staff] });
		account.resolve(observed);
		await expect(result).rejects.toThrow("Choose active agents");
		expect(f.folder).not.toHaveBeenCalled();
	});
	it("checks access again after reading the group chats, before creating one", async () => {
		const f = setup();
		const stateFolders = f.fake.folder.stateFolders.getMockImplementation()!;
		f.fake.folder.stateFolders.mockImplementationOnce(async (...args) => {
			const answer = await stateFolders(...args);
			f.company.store.set({ accessLost: true });
			return answer;
		});
		await expect(f.start([staff.id, f.other.id], "Hello", f.signal)).rejects.toThrow("permission");
		expect(f.fake.commits).toHaveLength(0);
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
		expect(f.folder).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
	});
});
