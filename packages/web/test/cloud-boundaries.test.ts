// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi } from "../src/cloud/api.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { collectPages } from "../src/cloud/pagination.ts";
import { figureElement } from "../src/ui/avatar.ts";
import { fixture, id, profileA, session, settle, stubFigureMotion, timestamp, userA } from "./fixtures.ts";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("cloud boundary regressions", () => {
	it("reads session continuation pages using the deployed cursor shape", async () => {
		const { cloud } = fixture();
		const wire = {
			session_id: session.sessionId,
			client_session_id: session.clientSessionId,
			profile_id: profileA.profileId,
			environment_id: profileA.environmentId,
			title: session.title,
			status: "open",
			audience_kind: "company",
			created_by_user_id: userA.id,
			created_at: timestamp,
			updated_at: timestamp,
		};
		vi.mocked(cloud.rpc)
			.mockResolvedValueOnce({
				items: [wire],
				has_more: true,
				next_updated_at: timestamp,
				next_id: session.sessionId,
			})
			.mockResolvedValueOnce({ items: [{ ...wire, session_id: id(99) }], has_more: false });
		const api = new CloudApi(cloud);
		const sessions = await api.listSessions(profileA.environmentId);
		expect(sessions).toHaveLength(2);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_list_shared_sessions_page", {
			p_environment_id: profileA.environmentId,
			p_after_updated_at: timestamp,
			p_after_id: session.sessionId,
			p_limit: 100,
		});
	});

	it("reads a conversation's erasure generation from its session row, and nothing else as one", async () => {
		const answers: { data: unknown; error: unknown }[] = [
			{ data: { memory_generation: 3 }, error: null },
			{ data: null, error: null },
			{ data: { memory_generation: "3" }, error: null },
			{ data: { memory_generation: -1 }, error: null },
			{ data: { memory_generation: 1.5 }, error: null },
			{ data: null, error: { message: "permission denied", code: "42501" } },
		];
		const maybeSingle = vi.fn(async () => answers.shift());
		const eq = vi.fn(() => ({ maybeSingle }));
		const select = vi.fn(() => ({ eq }));
		const from = vi.fn(() => ({ select }));
		const { cloud } = fixture();
		const api = new CloudApi({ ...cloud, supabase: { from } } as unknown as Cloud);
		await expect(api.readSessionMemoryGeneration(session.sessionId)).resolves.toBe(3);
		expect(from).toHaveBeenCalledWith("qorpera_shared_sessions");
		expect(select).toHaveBeenCalledWith("memory_generation");
		expect(eq).toHaveBeenCalledWith("id", session.sessionId);
		for (let unreadable = 0; unreadable < 4; unreadable++)
			await expect(api.readSessionMemoryGeneration(session.sessionId)).resolves.toBeUndefined();
		await expect(api.readSessionMemoryGeneration(session.sessionId)).rejects.toMatchObject({ code: "42501" });
		await expect(api.readSessionMemoryGeneration("not a session")).rejects.toThrow();
		expect(from).toHaveBeenCalledTimes(6);
		expect(cloud.rpc).not.toHaveBeenCalled();
	});

	it("fails incomplete or cycling pagination instead of returning a truncated complete list", async () => {
		await expect(collectPages(async () => ({ items: [1], hasMore: true }))).rejects.toThrow("without a continuation");
		const read = vi.fn(async () => ({ items: [1], hasMore: true, nextTime: timestamp, nextId: id(1) }));
		await expect(collectPages(read)).rejects.toThrow("did not advance");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("disposes removed avatar rigs without requiring another mount", async () => {
		const dispose = vi.fn();
		stubFigureMotion(dispose);
		const retained = figureElement("crown");
		document.body.append(retained);
		await settle();
		expect(dispose).not.toHaveBeenCalled();
		retained.remove();
		await settle();
		expect(dispose).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 6; i++) {
			const figure = figureElement("crown");
			document.body.append(figure);
			figure.remove();
		}
		await settle();
		expect(dispose).toHaveBeenCalledTimes(7);
	});
});
