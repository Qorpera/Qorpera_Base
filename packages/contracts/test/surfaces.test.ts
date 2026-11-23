import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	countOpenSurfaceChanges,
	nextSurfaceSessionLifecycleState,
	parsePointToChangeTarget,
	parseSurfaceSession,
	parseSurfaceSummary,
	SURFACE_SITE_DOOR_ACTION_PATTERN,
} from "../src/surfaces.ts";

describe("surfaces contracts", () => {
	it("enforces the multi-change session auto-close invariant", () => {
		expect(
			nextSurfaceSessionLifecycleState({
				state: "ready",
				hasActiveChat: false,
				changes: [{ status: "merged" }, { status: "staged" }],
			}),
		).toBe("ready");

		expect(
			nextSurfaceSessionLifecycleState({
				state: "ready",
				hasActiveChat: true,
				changes: [{ status: "merged" }, { status: "merged" }],
			}),
		).toBe("ready");

		expect(
			nextSurfaceSessionLifecycleState({
				state: "running",
				hasActiveChat: false,
				changes: [{ status: "merged" }],
			}),
		).toBe("running");

		expect(
			nextSurfaceSessionLifecycleState({
				state: "ready",
				hasActiveChat: false,
				changes: [{ status: "merged" }, { status: "discarded" }],
			}),
		).toBe("completed");

		expect(
			nextSurfaceSessionLifecycleState({
				state: "ready",
				hasActiveChat: false,
				changes: [{ status: "discarded" }, { status: "discarded" }],
			}),
		).toBe("discarded");

		expect(countOpenSurfaceChanges([{ status: "staged" }, { status: "merged" }, { status: "conflicted" }])).toBe(2);
	});

	it("parses valid surface summaries, sessions, and Point-to-Change targets", () => {
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const now = "2026-11-21T03:00:00Z";

		const summary = parseSurfaceSummary({
			id: surfaceId,
			slug: "website",
			title: "Website",
			group: "products",
			archetype: "live_build",
			status: "active",
			icon: "globe",
			sourceKind: "code_repo",
			repositoryKey: "thetaband/website",
			folderRoot: null,
			siteSlug: "thetaband",
			previewMode: "static_site",
			autoPublish: false,
			liveUrl: "https://thetaband.qorpera.com/",
			hasUnpublishedChanges: true,
			unpublishedChangeCount: 2,
			activeSessionCount: 3,
			runningSessionCount: 1,
			pendingChangeCount: 4,
			needsAttentionCount: 0,
			sortOrder: 10,
		});
		expect(summary.slug).toBe("website");
		expect(summary.autoPublish).toBe(false);

		const session = parseSurfaceSession({
			id: sessionId,
			surfaceId,
			workerId: null,
			title: "Add FAQ and tune hero",
			prompt: "Add Danish FAQ and adjust hero padding",
			state: "ready",
			originKind: "member",
			originLabel: null,
			explorationId: null,
			explorationVariantLabel: null,
			hasActiveChat: false,
			question: null,
			changes: [
				{
					id: changeId,
					sessionId,
					surfaceId,
					seq: 1,
					title: "Add Danish FAQ",
					summary: "Adds expandable Danish FAQ below pricing.",
					kind: "git_range",
					status: "staged",
					parentSha: "a".repeat(40),
					headSha: "b".repeat(40),
					dependsOnChangeIds: [],
					affectedPaths: ["src/faq.html"],
					diffStats: { filesChanged: 1, additions: 42, deletions: 0 },
					conflictPaths: null,
					landedChangeNumber: null,
					canUndo: false,
					createdAt: now,
					resolvedAt: null,
				},
			],
			createdAt: now,
			updatedAt: now,
			closedAt: null,
		});
		expect(session.openChangeCount).toBe(1);

		const target = parsePointToChangeTarget({
			route: "/preorder",
			selector: "section.pricing > button.cta",
			textSnippet: "Se forudbestillingen",
			tagName: "button",
			componentHint: "PreorderCta",
			boundingBox: { x: 120, y: 440, width: 220, height: 48 },
			viewport: { width: 1280, height: 800 },
		});
		expect(target.route).toBe("/preorder");
		expect(target.componentHint).toBe("PreorderCta");
		expect(session.messages).toEqual([]);
		expect(SURFACE_SITE_DOOR_ACTION_PATTERN.test("https://thetaband.qorpera.com/__qorpera/member")).toBe(true);
		expect(SURFACE_SITE_DOOR_ACTION_PATTERN.test("https://thetaband--pab12cd34.qorpera.com/__qorpera/member")).toBe(
			true,
		);
		expect(SURFACE_SITE_DOOR_ACTION_PATTERN.test("https://thetaband--next.qorpera.com/__qorpera/member")).toBe(false);
	});

	it("parses Identity global metadata, attribution, patchManifest, Notes, and publish durability fields", () => {
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const messageId = randomUUID();
		const userId = randomUUID();
		const now = "2026-11-21T20:00:00Z";

		const summary = parseSurfaceSummary({
			id: surfaceId,
			slug: "identity",
			title: "Identity",
			group: "products",
			archetype: "studio",
			kind: "identity",
			accentHex: "#d76f45",
			isGlobal: true,
			status: "active",
			icon: "spark",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "identity",
			siteSlug: null,
			previewMode: "studio_overlay",
			autoPublish: false,
			publishStatus: "publishing",
			liveUrl: null,
			hasUnpublishedChanges: true,
			unpublishedChangeCount: 1,
			activeSessionCount: 1,
			runningSessionCount: 0,
			pendingChangeCount: 1,
			needsAttentionCount: 0,
			sortOrder: 0,
		});
		expect(summary.kind).toBe("identity");
		expect(summary.accentHex).toBe("#d76f45");
		expect(summary.isGlobal).toBe(true);
		expect(summary.publishStatus).toBe("publishing");

		const session = parseSurfaceSession({
			id: sessionId,
			surfaceId,
			workerId: null,
			title: "Design tokens & Danish voice",
			prompt: "Define core tokens",
			state: "ready",
			originKind: "cofounder",
			originLabel: "Co-Founder",
			createdByUserId: userId,
			explorationId: null,
			explorationVariantLabel: null,
			hasActiveChat: false,
			question: null,
			notePaths: ["identity/notes/calm-tech.report.json"],
			changes: [
				{
					id: changeId,
					sessionId,
					surfaceId,
					seq: 1,
					title: "Update palette tokens",
					summary: "Refines warm linen palette.",
					kind: "folder_patch",
					status: "merged",
					parentSha: null,
					headSha: null,
					dependsOnChangeIds: [],
					affectedPaths: ["tokens.json"],
					patchManifest: [{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45" } }],
					diffStats: { filesChanged: 1, additions: 4, deletions: 1 },
					conflictPaths: null,
					landedChangeNumber: null,
					canUndo: true,
					publishedAt: null,
					approvedByUserId: userId,
					createdAt: now,
					resolvedAt: now,
				},
			],
			messages: [
				{
					id: messageId,
					sessionId,
					authorKind: "member",
					authorUserId: userId,
					text: "Make the accent slightly warmer",
					changeId: null,
					createdAt: now,
				},
			],
			createdAt: now,
			updatedAt: now,
			closedAt: null,
		});
		expect(session.createdByUserId).toBe(userId);
		expect(session.notePaths).toEqual(["identity/notes/calm-tech.report.json"]);
		expect(session.changes[0]?.patchManifest).toEqual([
			{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45" } },
		]);
		expect(session.changes[0]?.approvedByUserId).toBe(userId);
		expect(session.changes[0]?.publishedAt).toBeNull();
		expect(session.messages[0]?.authorUserId).toBe(userId);
	});

	it("parses optional lastPublishError, liveHeadSha, and branchHeadSha metadata", () => {
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const now = "2026-11-21T03:00:00Z";
		const summary = parseSurfaceSummary({
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
			publishStatus: "failed",
			lastPublishError: "Build failed on index.html",
			liveHeadSha: "a".repeat(40),
			liveUrl: "https://website.qorpera.com/",
			hasUnpublishedChanges: true,
			unpublishedChangeCount: 1,
			activeSessionCount: 1,
			runningSessionCount: 0,
			pendingChangeCount: 0,
			needsAttentionCount: 0,
			sortOrder: 0,
		});
		expect(summary.lastPublishError).toBe("Build failed on index.html");
		expect(summary.liveHeadSha).toBe("a".repeat(40));

		const session = parseSurfaceSession({
			id: sessionId,
			surfaceId,
			workerId: null,
			title: "Variant A",
			prompt: "Try layout A",
			state: "ready",
			originKind: "member",
			originLabel: null,
			explorationId: null,
			explorationVariantLabel: "Minimal",
			branchHeadSha: "b".repeat(40),
			hasActiveChat: false,
			question: null,
			changes: [],
			messages: [],
			createdAt: now,
			updatedAt: now,
			closedAt: null,
		});
		expect(session.branchHeadSha).toBe("b".repeat(40));
	});

	it("parses a surface's ask to publish", () => {
		const base = {
			id: randomUUID(),
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
			sortOrder: 0,
		};
		const ask = {
			askedByUserId: randomUUID(),
			askedUserId: randomUUID(),
			askedAt: "2026-11-23T01:06:00Z",
			changeCount: 1,
			status: "declined",
			answeredAt: "2026-11-23T01:09:00Z",
		};
		expect(parseSurfaceSummary({ ...base, publishAsk: ask }).publishAsk).toEqual(ask);
		expect(parseSurfaceSummary({ ...base, publishAsk: null }).publishAsk).toBeNull();
		expect("publishAsk" in parseSurfaceSummary(base)).toBe(false);
		expect(() => parseSurfaceSummary({ ...base, publishAsk: { ...ask, status: "accepted" } })).toThrow(
			"surface.publishAsk.status",
		);
	});
});
