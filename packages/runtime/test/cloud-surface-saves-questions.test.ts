import { createHash, randomUUID } from "node:crypto";
import type { SurfaceFolderContents } from "@qorpera/cloud-client/surface-folder-files";
import type { CloudNativeToolIdentity } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudToolContext } from "@qorpera/runtime/cloud-native-tool-boundary";
import type { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { prepareSurfaceCodingWorkspace } from "@qorpera/runtime/cloud-surface-coding-tools";
import {
	runSurfaceSessionTurn,
	type SurfaceFolderOrOpsTurnRequest,
	type SurfaceSessionTurnInput,
} from "@qorpera/runtime/cloud-surface-session-runner";
import { describe, expect, it, vi } from "vitest";

const IDENTITY: CloudNativeToolIdentity = {
	companyId: "55555555-5555-4555-8555-555555555555",
	environmentId: "77777777-7777-4777-8777-777777777777",
	runId: "44444444-4444-4444-8444-444444444444",
	jobId: "88888888-8888-4888-8888-888888888881",
	runnerId: "88888888-8888-4888-8888-888888888882",
	assignmentId: "88888888-8888-4888-8888-888888888883",
	leaseId: "88888888-8888-4888-8888-888888888884",
	computeIdentityId: "88888888-8888-4888-8888-888888888885",
	staffAgentId: "66666666-6666-4666-8666-666666666666",
	staffVersion: 1,
	sessionId: null,
	requesterUserId: "88888888-8888-4888-8888-888888888886",
	sponsorUserId: null,
	sponsorBindingId: "88888888-8888-4888-8888-888888888887",
	sponsorVersion: 1,
	providerConnectionId: "88888888-8888-4888-8888-888888888888",
	providerConnectionVersion: 1,
	audienceKind: "company",
	audienceUserId: null,
	runtimeBundleId: "88888888-8888-4888-8888-888888888889",
	runtimeBundleSha256: "a".repeat(64),
	reasoningEffort: "medium",
	reasoningPolicySha256: "b".repeat(64),
	provider: "openai",
	nativeHarness: "codex-cli",
	model: "gpt-5.4",
};

const OPERATIONS = {
	execute: async () => {
		throw new Error("nothing is written in these tests");
	},
} as unknown as CloudNativeToolOperations;

const CONTEXT: CloudToolContext = {
	companyId: IDENTITY.companyId,
	runId: IDENTITY.runId,
	callId: "call_1",
	argumentSha256: createHash("sha256").update("x").digest("hex"),
	signal: new AbortController().signal,
};

interface Page {
	readonly surfaceSlug: string;
	readonly surfaceKind: string;
	readonly surfaceIcon: string;
	readonly reconciling?: boolean;
}

const ANALYTICS: Page = { surfaceSlug: "numbers", surfaceKind: "dashboard", surfaceIcon: "chart" };
const BY_SLUG: Page = { surfaceSlug: "analytics", surfaceKind: "custom", surfaceIcon: "star" };
const CUSTOM: Page = { surfaceSlug: "field-notes", surfaceKind: "custom", surfaceIcon: "star" };
const STRATEGY: Page = { surfaceSlug: "strategy", surfaceKind: "strategy", surfaceIcon: "figure:lighthouse" };
const PRODUCT: Page = { surfaceSlug: "sandstone", surfaceKind: "product", surfaceIcon: "box" };
const REPORT: Page = { surfaceSlug: "journal", surfaceKind: "report", surfaceIcon: "book" };
const RECONCILING: Page = { ...ANALYTICS, reconciling: true };
const CUSTOM_RECONCILING: Page = { ...CUSTOM, reconciling: true };

const CASES: readonly (readonly [string, Page, boolean])[] = [
	["an Analytics page", ANALYTICS, true],
	["a page named analytics", BY_SLUG, true],
	["a Custom page, for its numbers tab", CUSTOM, true],
	["Strategy, for its numbers tab", STRATEGY, true],
	["a Product page, for its numbers tab", PRODUCT, true],
	["a reading page, which has no layout", REPORT, false],
	["an Analytics page's background reconciliation", RECONCILING, false],
	["a Custom page's background reconciliation", CUSTOM_RECONCILING, false],
];

describe("which Studio sessions may save a named question", () => {
	it.each(CASES)("runSurfaceSessionTurn: %s", async (_name, page, saves) => {
		let seen: SurfaceFolderOrOpsTurnRequest | undefined;
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				sourceKind: "folder",
				prompt: "Work on the page.",
				surfaceSlug: page.surfaceSlug,
				surfaceTitle: page.surfaceSlug,
				surfaceKind: page.surfaceKind,
				surfaceIcon: page.surfaceIcon,
				surfaceIsGlobal: false,
				surfaceArchetype: "studio",
				folderRoot: `surfaces/${page.surfaceSlug}`,
				...(page.reconciling ? { isInternal: true, state: "reconciling" } : {}),
			} as SurfaceSessionTurnInput,
			{
				readStudioFiles: async (): Promise<SurfaceFolderContents> => ({ files: {}, binaries: {} }),
				surfaceTools: { stageSurfacePatch: vi.fn() },
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
				async executeTurn(req) {
					seen = req as SurfaceFolderOrOpsTurnRequest;
					return { state: "ready", replyText: "Done." };
				},
			},
		);
		expect(seen?.savesQuestions).toBe(saves);
	});

	it.each(CASES)("prepareSurfaceCodingWorkspace: %s", async (_name, page, saves) => {
		const folder = {
			list: vi.fn(async () => ({ entries: [] })),
			readRange: vi.fn(),
			readText: vi.fn(async () => null),
			read: vi.fn(async () => ({ asOfSeq: 1, entry: null })),
		} as unknown as Parameters<typeof prepareSurfaceCodingWorkspace>[0]["folder"];
		const prepared = await prepareSurfaceCodingWorkspace({
			workspaceKind: "surface_folder",
			folder,
			surfaceSession: {
				sessionId: randomUUID(),
				surfaceSlug: page.surfaceSlug,
				surfaceTitle: page.surfaceSlug,
				surfaceKind: page.surfaceKind,
				surfaceIcon: page.surfaceIcon,
				surfaceIsGlobal: false,
				surfaceArchetype: "studio",
				folderRoot: `surfaces/${page.surfaceSlug}`,
				briefMarkdown: null,
				fullPrompt: "Work on the page.",
				...(page.reconciling ? { isInternalReconciliation: true } : {}),
				stageSurfacePatch: vi.fn(async () => ({ changeId: randomUUID(), seq: 1, openChangeCount: 1 })),
			} as unknown as Parameters<typeof prepareSurfaceCodingWorkspace>[0]["surfaceSession"],
			isClaudeTurn: false,
			newDisk: false,
			signal: new AbortController().signal,
		});
		const write = prepared.buildTools(IDENTITY, OPERATIONS).find((tool) => tool.name === "company_write");
		expect(write).toBeDefined();
		const args = write!.parseArguments({
			path: "data/shop/queries/bookings.sql",
			operationKey: "save-question-1",
			expectedVersion: null,
			text: "select 1;\n",
		});
		const refusal = await write!.execute(args, CONTEXT).then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expect(refusal).toContain(
			saves ? "there is no database data/shop/" : "outside this Surface worker's writable roots",
		);
	});
});
