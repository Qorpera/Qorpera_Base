import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	countOpenSurfaceChanges,
	nextSurfaceSessionLifecycleState,
	parsePointToChangeTarget,
	parseSurfaceSession,
	parseSurfaceSummary,
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
	});
});
