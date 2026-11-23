import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
	CloudSurfacesClient,
	parseSurfaceManifestToml,
	parseSurfaceOrderFile,
	renderSurfaceManifestToml,
	renderSurfaceOrderFile,
	surfaceManifestPath,
} from "../src/surfaces.ts";

describe("cloud-client surface state files", () => {
	it("round-trips surface.toml manifests and rejects slug mismatches or unknown keys", () => {
		const path = surfaceManifestPath("website");
		const text = renderSurfaceManifestToml({
			schema: "qorpera.surface/v1",
			slug: "website",
			title: "Website",
			group: "products",
			archetype: "live_build",
			icon: "globe",
			status: "active",
			autoPublish: true,
			source: {
				kind: "code_repo",
				repository: "thetaband/website",
				baseBranch: "main",
				siteSlug: "thetaband",
				folderRoot: null,
			},
			preview: {
				mode: "static_site",
				defaultRoute: "/",
				allowCompare: true,
				allowPointToChange: true,
			},
		});

		const parsed = parseSurfaceManifestToml(path, text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid manifest");
		expect(parsed.file.slug).toBe("website");
		expect(parsed.file.autoPublish).toBe(true);
		expect(parsed.file.source.siteSlug).toBe("thetaband");
		expect(parsed.file.preview.allowCompare).toBe(true);

		const mismatch = parseSurfaceManifestToml(surfaceManifestPath("brand"), text);
		expect(mismatch.ok).toBe(false);

		const unknownKey = parseSurfaceManifestToml(path, `${text}\nextra_key = true\n`);
		expect(unknownKey.ok).toBe(false);
	});

	it("parses and renders QorperaOS/surfaces/order.md cleanly", () => {
		const rendered = renderSurfaceOrderFile({
			products: ["website", "meditation-app", "headband", "brand"],
			operations: ["inbox", "money", "files"],
		});
		const parsed = parseSurfaceOrderFile(rendered);
		expect(parsed).toEqual({
			products: ["website", "meditation-app", "headband", "brand"],
			operations: ["inbox", "money", "files"],
		});
	});

	it("round-trips Identity global surface.toml fields and rejects bad accent hex", () => {
		const path = surfaceManifestPath("identity");
		const text = renderSurfaceManifestToml({
			schema: "qorpera.surface/v1",
			slug: "identity",
			title: "Identity",
			group: "products",
			archetype: "studio",
			kind: "identity",
			accentHex: "#d76f45",
			isGlobal: true,
			icon: "spark",
			status: "active",
			autoPublish: false,
			source: {
				kind: "folder",
				repository: null,
				baseBranch: null,
				siteSlug: null,
				folderRoot: "identity",
			},
			preview: {
				mode: "studio_overlay",
				defaultRoute: "/",
				allowCompare: false,
				allowPointToChange: false,
			},
		});
		const parsed = parseSurfaceManifestToml(path, text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid identity manifest");
		expect(parsed.file.kind).toBe("identity");
		expect(parsed.file.accentHex).toBe("#d76f45");
		expect(parsed.file.isGlobal).toBe(true);

		const badAccent = parseSurfaceManifestToml(path, text.replace("#d76f45", "not-a-color"));
		expect(badAccent.ok).toBe(false);
	});
});

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
