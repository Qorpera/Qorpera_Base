import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { CloudSurfacesClient } from "../src/surfaces.ts";

describe("cloud-client surface session images", () => {
	const surfaceId = "29600000-0000-4000-8000-000000000001";
	const sessionId = "29600000-0000-4000-8000-000000000002";
	const clientInputId = "29600000-0000-4000-8000-000000000003";
	const messageId = "29600000-0000-4000-8000-000000000004";
	const image = { sha256: "a".repeat(64), bytes: 12, mediaType: "image/png" };
	const session = {
		id: sessionId,
		surfaceId,
		workerId: null,
		title: "Fix the header",
		prompt: "Fix the header",
		state: "queued",
		originKind: "member",
		originLabel: null,
		explorationId: null,
		explorationVariantLabel: null,
		hasActiveChat: true,
		question: null,
		changes: [],
		messages: [],
		createdAt: "2026-11-23T10:00:00.000Z",
		updatedAt: "2026-11-23T10:00:00.000Z",
		closedAt: null,
	};

	function fixture(data: unknown = session) {
		const rpc = vi.fn(async () => ({ data, error: null }));
		return { rpc, client: new CloudSurfacesClient({ rpc } as unknown as SupabaseClient) };
	}

	it("starts and replies through the plain RPCs without images", async () => {
		const { rpc, client } = fixture();
		await client.startSurfaceSession(surfaceId, "Fix the header", { clientInputId, images: [] });
		await client.replySurfaceSession(sessionId, "And the footer", true);
		await client.replySurfaceSession(sessionId, "And the footer", false, { clientInputId, images: [] });
		expect(rpc.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
			"qorpera_start_surface_session",
			"qorpera_reply_surface_session",
			"qorpera_reply_surface_session",
		]);
		expect((rpc.mock.calls[0] as unknown[])[1]).not.toHaveProperty("p_images");
	});

	it("starts and replies through the image RPCs with the images as their folder hashes", async () => {
		const { rpc, client } = fixture();
		await client.startSurfaceSession(surfaceId, "Fix the header", { clientInputId, images: [image] });
		await client.replySurfaceSession(sessionId, "Like this", true, { clientInputId, images: [image] });
		const row = { objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType };
		expect(rpc.mock.calls[0]).toEqual([
			"qorpera_start_surface_session_with_images",
			expect.objectContaining({ p_surface_id: surfaceId, p_client_input_id: clientInputId, p_images: [row] }),
		]);
		expect(rpc.mock.calls[1]).toEqual([
			"qorpera_reply_surface_session_with_images",
			{
				p_session_id: sessionId,
				p_message: "Like this",
				p_keep_open: true,
				p_client_input_id: clientInputId,
				p_images: [row],
			},
		]);
		await expect(client.startSurfaceSession(surfaceId, "Fix", { images: [image] })).rejects.toThrow(
			"client input id",
		);
	});

	it("forwards target changeId on replySurfaceSession with and without images", async () => {
		const changeId = "29600000-0000-4000-8000-000000000099";
		const { rpc, client } = fixture();
		await client.replySurfaceSession(sessionId, "Re: [Hero]\nMake it warmer", true, undefined, changeId);
		await client.replySurfaceSession(
			sessionId,
			"Re: [Hero]\nMatch this",
			true,
			{ clientInputId, images: [image] },
			changeId,
		);
		const row = { objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType };
		expect(rpc.mock.calls[0]).toEqual([
			"qorpera_reply_surface_session",
			{
				p_session_id: sessionId,
				p_message: "Re: [Hero]\nMake it warmer",
				p_keep_open: true,
				p_change_id: changeId,
			},
		]);
		expect(rpc.mock.calls[1]).toEqual([
			"qorpera_reply_surface_session_with_images",
			{
				p_session_id: sessionId,
				p_message: "Re: [Hero]\nMatch this",
				p_keep_open: true,
				p_client_input_id: clientInputId,
				p_images: [row],
				p_change_id: changeId,
			},
		]);
	});

	it("reads a session's images and refuses a malformed answer", async () => {
		const answer = {
			schema: "qorpera.surface-session-images/v1",
			sessionId,
			messages: [{ messageId, clientInputId, images: [image] }],
		};
		expect(await fixture(answer).client.surfaceSessionImages(sessionId)).toEqual({
			sessionId,
			messages: [{ messageId, clientInputId, images: [image] }],
		});
		const { rpc } = fixture(answer);
		await new CloudSurfacesClient({ rpc } as unknown as SupabaseClient).surfaceSessionImages(sessionId);
		expect(rpc).toHaveBeenCalledWith("qorpera_surface_session_images", { p_session_id: sessionId });
		for (const bad of [
			{ ...answer, schema: "qorpera.surface-session-images/v2" },
			{ ...answer, messages: [{ messageId, clientInputId, images: [] }] },
			{ ...answer, messages: [{ messageId, clientInputId, images: [{ ...image, mediaType: "image/svg+xml" }] }] },
			{ ...answer, messages: [{ messageId, clientInputId, images: [{ ...image, path: "QorperaOS/x" }] }] },
		])
			await expect(fixture(bad).client.surfaceSessionImages(sessionId)).rejects.toThrow();
	});

	it("writes a note to teammates, reads its recipients and whose turn the session is on", async () => {
		const jonas = "29600000-0000-4000-8000-000000000005";
		const sofie = "29600000-0000-4000-8000-000000000006";
		const note = {
			id: messageId,
			sessionId,
			authorKind: "note",
			authorUserId: sofie,
			text: "@Jonas does it look right?",
			changeId: null,
			noteTo: [jonas],
			createdAt: "2026-11-23T10:01:00.000Z",
		};
		const { rpc, client } = fixture({ ...session, turnRequestedByUserId: sofie, messages: [note] });
		const answered = await client.noteSurfaceSession(sessionId, "@Jonas does it look right?", [jonas]);
		expect(rpc).toHaveBeenCalledWith("qorpera_surface_session_note", {
			p_session_id: sessionId,
			p_message: "@Jonas does it look right?",
			p_to: [jonas],
		});
		expect(answered.turnRequestedByUserId).toBe(sofie);
		expect(answered.messages[0]).toMatchObject({ authorKind: "note", noteTo: [jonas] });
		await expect(
			fixture({ ...session, messages: [{ ...note, noteTo: ["x"] }] }).client.noteSurfaceSession(sessionId, "Hi", [
				jonas,
			]),
		).rejects.toThrow();
	});

	it("lists the member's unseen notes and marks a session's seen", async () => {
		const unseen = [{ surfaceId, sessionId, count: 2 }];
		const { rpc, client } = fixture(unseen);
		expect(await client.unseenSurfaceNotes(surfaceId)).toEqual(unseen);
		expect(rpc).toHaveBeenCalledWith("qorpera_surface_unseen_notes", { p_profile_id: surfaceId });
		await client.markSurfaceNotesSeen(sessionId);
		expect(rpc).toHaveBeenLastCalledWith("qorpera_surface_notes_seen", { p_session_id: sessionId });
		await expect(
			fixture([{ surfaceId, sessionId, count: 0 }]).client.unseenSurfaceNotes(surfaceId),
		).rejects.toThrow();
		await expect(fixture({}).client.unseenSurfaceNotes(surfaceId)).rejects.toThrow();
	});
});

describe("cloud-client surface publish asks", () => {
	const surfaceId = "13490000-0000-4000-8000-000000000001";
	const userId = "13490000-0000-4000-8000-000000000002";
	const ask = {
		askedByUserId: "13490000-0000-4000-8000-000000000003",
		askedUserId: userId,
		askedAt: "2026-11-23T01:06:00Z",
		changeCount: 1,
		status: "open",
		answeredAt: null,
	};
	const summary = {
		id: surfaceId,
		slug: "website",
		title: "Website",
		group: "products",
		archetype: "live_build",
		status: "active",
		icon: "globe",
		sourceKind: "code_repo",
		repositoryKey: "surfaces/website",
		folderRoot: null,
		siteSlug: "website",
		previewMode: "static_site",
		autoPublish: false,
		liveUrl: "https://website.qorpera.com/",
		hasUnpublishedChanges: true,
		unpublishedChangeCount: 1,
		publishAsk: ask,
	};

	it("asks, declines and takes back through their RPCs and parses the ask", async () => {
		const rpc = vi.fn(async () => ({ data: summary, error: null }));
		const client = new CloudSurfacesClient({ rpc } as unknown as SupabaseClient);
		expect((await client.askSurfacePublish(surfaceId, userId)).publishAsk).toEqual(ask);
		await client.declineSurfacePublishAsk(surfaceId);
		await client.withdrawSurfacePublishAsk(surfaceId);
		expect(rpc.mock.calls).toEqual([
			["qorpera_ask_surface_publish", { p_surface_id: surfaceId, p_user_id: userId }],
			["qorpera_decline_surface_publish_ask", { p_surface_id: surfaceId }],
			["qorpera_withdraw_surface_publish_ask", { p_surface_id: surfaceId }],
		]);
		const bad = vi.fn(async () => ({
			data: { ...summary, publishAsk: { ...ask, askedUserId: "sofie" } },
			error: null,
		}));
		await expect(
			new CloudSurfacesClient({ rpc: bad } as unknown as SupabaseClient).askSurfacePublish(surfaceId, userId),
		).rejects.toThrow("surface.publishAsk.askedUserId");
	});
});

describe("cloud-client surface automation owners", () => {
	const automationId = "13500000-0000-4000-8000-000000000001";
	const offerId = "13500000-0000-4000-8000-000000000002";
	const jonas = "13500000-0000-4000-8000-000000000003";
	const sofie = "13500000-0000-4000-8000-000000000004";
	const automation = {
		id: automationId,
		key: "tidy-files",
		title: "Tidy Files",
		prompt: "Sort new uploads",
		scheduleSummary: "Mondays 08:00",
		targetSurfaceSlug: "files",
		outputMode: "surface_session",
		enabled: true,
		status: "idle",
		lastRunAt: null,
		lastOutcomeSummary: null,
		nextRunAt: null,
		ownable: true,
		ownerUserId: jonas,
		offer: {
			id: offerId,
			fromUserId: jonas,
			toUserId: sofie,
			offeredByUserId: jonas,
			status: "open",
			answeredAt: null,
		},
	};

	function fixture(data: unknown) {
		const rpc = vi.fn(async () => ({ data, error: null }));
		return { rpc, client: new CloudSurfacesClient({ rpc } as unknown as SupabaseClient) };
	}

	it("offers an automation and answers an offer, reading the owner and the offer back", async () => {
		const offered = fixture({ moved: false, automation });
		expect(await offered.client.offerAutomation(automationId, sofie)).toMatchObject({
			ownerUserId: jonas,
			offer: { id: offerId, toUserId: sofie, status: "open" },
		});
		expect(offered.rpc).toHaveBeenCalledWith("qorpera_offer_surface_automation", {
			p_automation_id: automationId,
			p_to_user_id: sofie,
		});
		const answered = fixture({
			status: "yes",
			moved: true,
			automation: { ...automation, ownerUserId: sofie, offer: null },
		});
		expect(await answered.client.answerAutomationOffer(offerId, true)).toMatchObject({
			ownerUserId: sofie,
			offer: null,
		});
		expect(answered.rpc).toHaveBeenCalledWith("qorpera_answer_surface_automation_offer", {
			p_offer_id: offerId,
			p_yes: true,
		});
	});

	it("refuses an answer without the automation, an unknown offer status or a missing owner flag", async () => {
		await expect(fixture({ moved: true }).client.offerAutomation(automationId, sofie)).rejects.toThrow();
		await expect(
			fixture({
				automation: { ...automation, offer: { ...automation.offer, status: "void" } },
			}).client.offerAutomation(automationId, sofie),
		).rejects.toThrow();
		const { ownable: _ownable, ...unowned } = automation;
		await expect(fixture([unowned]).client.listAutomations("13500000-0000-4000-8000-000000000009")).rejects.toThrow();
	});

	it("passes deduplicated previewBaseChangeIds inside p_origin_ref on startSurfaceSession without clobbering target", async () => {
		const surfaceId = "13500000-0000-4000-8000-000000000010";
		const sessionId = "13500000-0000-4000-8000-000000000011";
		const c1 = "13500000-0000-4000-8000-000000000012";
		const c2 = "13500000-0000-4000-8000-000000000013";
		const sessionPayload = {
			id: sessionId,
			surfaceId,
			workerId: null,
			title: "Promo",
			prompt: "Write promo",
			state: "queued",
			originKind: "member",
			originLabel: null,
			explorationId: null,
			explorationVariantLabel: null,
			hasActiveChat: false,
			question: null,
			changes: [],
			messages: [],
			createdAt: "2026-11-24T06:00:00Z",
			updatedAt: "2026-11-24T06:00:00Z",
			closedAt: null,
		};

		const rpcPlain = vi.fn().mockResolvedValue({ data: sessionPayload, error: null });
		const clientPlain = new CloudSurfacesClient({ rpc: rpcPlain } as unknown as SupabaseClient);
		await clientPlain.startSurfaceSession(surfaceId, "Write promo", { previewBaseChangeIds: [c1, c1, c2] });
		expect(rpcPlain).toHaveBeenCalledWith(
			"qorpera_start_surface_session",
			expect.objectContaining({
				p_origin_ref: { previewBaseChangeIds: [c1, c2] },
			}),
		);

		const rpcTarget = vi.fn().mockResolvedValue({ data: sessionPayload, error: null });
		const clientTarget = new CloudSurfacesClient({ rpc: rpcTarget } as unknown as SupabaseClient);
		await clientTarget.startSurfaceSession(surfaceId, "Refine hero", {
			previewBaseChangeIds: [c1],
			target: {
				route: "/",
				selector: "h1",
				tagName: "h1",
				textSnippet: "Hello",
				componentHint: null,
				boundingBox: { x: 0, y: 0, width: 100, height: 40 },
				viewport: { width: 1280, height: 800 },
			},
		});
		expect(rpcTarget).toHaveBeenCalledWith(
			"qorpera_start_surface_session",
			expect.objectContaining({
				p_origin_kind: "point_to_change",
				p_origin_ref: expect.objectContaining({
					selector: "h1",
					previewBaseChangeIds: [c1],
				}),
			}),
		);
	});
});

describe("cloud-client surface change option groups", () => {
	const surfaceId = "13740000-0000-4000-8000-000000000001";
	const sessionId = "13740000-0000-4000-8000-000000000002";
	const changeA = "13740000-0000-4000-8000-000000000003";
	const changeB = "13740000-0000-4000-8000-000000000004";
	const now = "2026-11-24T08:00:00Z";

	function makeChange(id: string, seq: number, status: "staged" | "discarded", groupKey: string | null) {
		return {
			id,
			sessionId,
			surfaceId,
			seq,
			title: `Option ${seq}`,
			summary: `Summary ${seq}`,
			kind: "git_range",
			status,
			parentSha: "a".repeat(40),
			headSha: `${seq}`.repeat(40),
			dependsOnChangeIds: [],
			affectedPaths: ["index.html"],
			diffStats: { filesChanged: 1, additions: 4, deletions: 1 },
			conflictPaths: null,
			landedChangeNumber: null,
			canUndo: false,
			optionGroupKey: groupKey,
			optionGroupTitle: groupKey ? "Homepage direction" : null,
			createdAt: now,
			resolvedAt: status === "discarded" ? now : null,
		};
	}

	it("calls qorpera_choose_surface_change_option and qorpera_discard_surface_option_group", async () => {
		const chosenSession = {
			id: sessionId,
			surfaceId,
			workerId: null,
			title: "Homepage directions",
			prompt: "Try two directions",
			state: "ready",
			originKind: "member",
			originLabel: null,
			explorationId: null,
			explorationVariantLabel: null,
			hasActiveChat: false,
			question: null,
			changes: [makeChange(changeA, 1, "discarded", "homepage-direction"), makeChange(changeB, 2, "staged", null)],
			messages: [],
			createdAt: now,
			updatedAt: now,
			closedAt: null,
		};
		const discardedSession = {
			...chosenSession,
			state: "discarded",
			changes: [
				makeChange(changeA, 1, "discarded", "homepage-direction"),
				makeChange(changeB, 2, "discarded", "homepage-direction"),
			],
			closedAt: now,
		};
		const rpc = vi
			.fn()
			.mockResolvedValueOnce({ data: chosenSession, error: null })
			.mockResolvedValueOnce({ data: discardedSession, error: null });
		const client = new CloudSurfacesClient({ rpc } as unknown as SupabaseClient);

		const chosen = await client.chooseSurfaceChangeOption(changeB);
		expect(rpc).toHaveBeenNthCalledWith(1, "qorpera_choose_surface_change_option", { p_change_id: changeB });
		expect(chosen.openChangeCount).toBe(1);
		expect(chosen.changes[1]?.optionGroupKey).toBeNull();
		expect(chosen.changes[0]?.status).toBe("discarded");

		const discarded = await client.discardSurfaceOptionGroup(sessionId, "homepage-direction");
		expect(rpc).toHaveBeenNthCalledWith(2, "qorpera_discard_surface_option_group", {
			p_session_id: sessionId,
			p_option_group_key: "homepage-direction",
		});
		expect(discarded.state).toBe("discarded");
		expect(discarded.openChangeCount).toBe(0);
	});
});
