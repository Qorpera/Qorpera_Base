import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudCompanyFolderClient, CloudCompanyFolderEntry } from "../src/cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "../src/cloud-company-path-gateway.ts";
import { cloudFolderFileTools } from "../src/cloud-folder-file-tools.ts";
import {
	createSurfaceFolderPreviewOverlay,
	parseSurfaceOmittedBaseChanges,
	parseSurfacePreviewContext,
} from "../src/cloud-surface-preview-overlay.ts";
import { runSurfaceSessionTurn } from "../src/cloud-surface-session-runner.ts";
import { buildSurfaceTurnBrief } from "../src/cloud-surface-turn-context.ts";

function makeLiveEntry(path: string, content: string | null): CloudCompanyFolderEntry {
	const authority = {
		resourceId: "11111111-1111-4111-8111-111111111111",
		resourceRevision: 1,
		grantId: "22222222-2222-4222-8222-222222222222",
		grantRevision: 1,
	};
	if (content === null) {
		return {
			path,
			kind: "folder",
			version: "33333333-3333-4333-8333-333333333333",
			seq: 1,
			updatedAt: "2026-11-24T00:00:00Z",
			authority,
		};
	}
	const bytes = Buffer.from(content, "utf8");
	const sha = createHash("sha256").update(bytes).digest("hex");
	return {
		path,
		kind: "file",
		version: randomUUID(),
		seq: 2,
		updatedAt: "2026-11-24T00:00:00Z",
		authority,
		file: {
			manifestSha256: sha,
			fileSha256: sha,
			bytes: bytes.byteLength,
			mediaType: "text/plain",
			executable: false,
		},
	};
}

describe("surface preview overlay and lineage turn context", () => {
	it("overlays modified, created, and deleted preview files in company_read and company_list while preserving real release provenance", async () => {
		const liveFiles: Record<string, string> = {
			"identity/tokens.json": '{"accent":"#222222"}\n',
			"identity/old.md": "Old draft\n",
			"identity/keep.md": "Keep me\n",
		};
		const liveEntries = new Map<string, CloudCompanyFolderEntry>([
			["identity", makeLiveEntry("identity", null)],
			...Object.entries(liveFiles).map(([path, text]) => [path, makeLiveEntry(path, text)] as const),
		]);
		const releasedCalls: { readonly id: string; readonly reads: readonly { readonly path: string }[] }[] = [];

		const fakeFolder = {
			async read(path: string) {
				return { entry: liveEntries.get(path) ?? null };
			},
			async readText(path: string) {
				const text = liveFiles[path];
				const entry = liveEntries.get(path);
				if (text === undefined || !entry || entry.kind !== "file") return null;
				return { entry, text };
			},
			async readRange(entry: Extract<CloudCompanyFolderEntry, { kind: "file" }>, offset: number, length: number) {
				const text = liveFiles[entry.path] ?? "";
				return Buffer.from(text, "utf8").subarray(offset, offset + length);
			},
			async list(parent: string, options: { recursive?: boolean }) {
				const entries = [...liveEntries.values()].filter((entry) => {
					if (parent === "") return options.recursive ? true : !entry.path.includes("/");
					if (!entry.path.startsWith(`${parent}/`)) return false;
					if (!options.recursive) return !entry.path.slice(parent.length + 1).includes("/");
					return true;
				});
				return { asOfSeq: 5, entries, next: null };
			},
			async release(id: string, reads: readonly { readonly path: string }[]) {
				releasedCalls.push({ id, reads });
			},
		} as unknown as CloudCompanyFolderClient;

		const c1 = randomUUID();
		const overlay = createSurfaceFolderPreviewOverlay({
			folderRoot: "identity",
			previewBaseChanges: [
				{
					changeId: c1,
					title: "Electric Blue",
					summary: "Updates accent, creates promo, removes old.md",
					kind: "folder_patch",
					parentSha: null,
					headSha: null,
					affectedPaths: ["tokens.json", "sub/promo.md", "old.md"],
					previewBaseChangeIds: [],
					patchManifest: [
						{ op: "merge_json", path: "tokens.json", patch: { accent: "#0070f3" } },
						{ op: "write_text", path: "sub/promo.md", content: "Line 1: Electric Blue\nLine 2: Launch\n" },
						{ op: "delete", path: "old.md" },
					],
					baseFiles: null,
				},
			],
			liveReader: fakeFolder,
		});
		expect(overlay).not.toBeNull();

		const tools = cloudFolderFileTools({
			folder: fakeFolder,
			operations: { completesFolderCommits: false, execute: vi.fn() } as never,
			identity: {
				companyId: randomUUID(),
				environmentId: randomUUID(),
				runId: randomUUID(),
				jobId: randomUUID(),
				runnerId: randomUUID(),
				assignmentId: randomUUID(),
				staffAgentId: "cofounder",
			} as never,
			previewOverlay: overlay!,
		});
		const readTool = tools.find((tool) => tool.name === "company_read")!;
		const listTool = tools.find((tool) => tool.name === "company_list")!;
		const ctx = { callId: "call-1", signal: new AbortController().signal } as never;

		const readTokens = await readTool.execute(readTool.parseArguments({ path: "identity/tokens.json" }), ctx);
		expect(readTokens.kind).toBe("text");
		if (readTokens.kind !== "text") throw new Error("expected text");
		expect(JSON.parse(readTokens.value).text).toContain("#0070f3");
		expect(releasedCalls.at(-1)?.reads.map((r) => r.path)).toEqual(["identity/tokens.json"]);

		const readVirtual = await readTool.execute(readTool.parseArguments({ path: "identity/sub/promo.md" }), ctx);
		if (readVirtual.kind !== "text") throw new Error("expected text");
		const virtualPayload = JSON.parse(readVirtual.value);
		expect(virtualPayload.text).toBe("Line 1: Electric Blue\nLine 2: Launch\n");
		expect(virtualPayload.version).toBeNull();
		expect(releasedCalls.at(-1)?.reads.map((r) => r.path)).toEqual(["identity"]);

		const readDeleted = await readTool.execute(readTool.parseArguments({ path: "identity/old.md" }), ctx);
		if (readDeleted.kind !== "text") throw new Error("expected text");
		expect(JSON.parse(readDeleted.value).kind).toBe("absent");

		const readMany = await readTool.execute(
			readTool.parseArguments({
				paths: [{ path: "identity/sub/promo.md", startLine: 2, endLine: 2 }, "identity/old.md"],
			}),
			ctx,
		);
		if (readMany.kind !== "text") throw new Error("expected text");
		const manyFiles = JSON.parse(readMany.value).files;
		expect(manyFiles[0].text).toBe("Line 2: Launch\n");
		expect(manyFiles[1].kind).toBe("absent");

		const listRoot = await listTool.execute(listTool.parseArguments({ path: "identity" }), ctx);
		if (listRoot.kind !== "text") throw new Error("expected text");
		expect(listRoot.value).toContain("identity/tokens.json");
		expect(listRoot.value).toContain("identity/keep.md");
		expect(listRoot.value).toContain("identity/sub/");
		expect(listRoot.value).not.toContain("identity/old.md");
		const lastListReads = releasedCalls.at(-1)?.reads.map((r) => r.path) ?? [];
		expect(lastListReads).not.toContain("identity/sub");

		const listVirtualSub = await listTool.execute(listTool.parseArguments({ path: "identity/sub" }), ctx);
		if (listVirtualSub.kind !== "text") throw new Error("expected text");
		expect(listVirtualSub.value).toContain("identity/sub/promo.md");
	});

	it("feeds preview-overlaid shared assets and baseFiles into folder surface turns and renders chain/omitted-base reconciliation briefs", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const c1 = randomUUID();
		const c2 = randomUUID();
		const c3 = randomUUID();

		const previewContext = parseSurfacePreviewContext({
			previewBaseChanges: [
				{
					changeId: c1,
					title: "Electric Blue accent",
					summary: "Updates tokens.json",
					kind: "folder_patch",
					parentSha: null,
					headSha: null,
					affectedPaths: ["tokens.json"],
					previewBaseChangeIds: [],
					patchManifest: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#0070f3"}\n' }],
					baseFiles: { "tokens.json": '{"accent":"#222222"}\n' },
				},
			],
			previewReconciliations: [],
		});

		const stagedRequests: unknown[] = [];
		let seenBrief = "";
		await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Add secondary color",
				previewBaseChanges: previewContext.previewBaseChanges,
				previewReconciliations: previewContext.previewReconciliations,
			},
			{
				folder: {
					async readText(path) {
						if (path === "identity/tokens.json") return { text: '{"accent":"#222222"}\n' };
						return null;
					},
				},
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					seenBrief = req.turnBrief;
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Add secondary",
						summary: "Keeps preview accent",
						ops: [
							{ op: "write_text", path: "tokens.json", content: '{"accent":"#0070f3","secondary":"#111"}\n' },
						],
					});
					await patchTool.execute(parsed, { companyId, runId: randomUUID(), signal: req.signal } as never);
					return { state: "ready", replyText: "Staged" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(seenBrief).toContain("## Active Preview Changes");
		expect(seenBrief).toContain("Electric Blue accent");
		expect((stagedRequests[0] as { baseFiles?: Record<string, string | null> }).baseFiles).toEqual({
			"tokens.json": '{"accent":"#0070f3"}\n',
		});

		const chainBrief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "identity",
			surfaceTitle: "Identity",
			sourceKind: "folder",
			isInternalReconciliation: true,
			briefMarkdown: null,
			folderRoot: "identity",
			chainMode: true,
			conflictPaths: ["tokens.json"],
			conflictDetails: [
				{
					changeId: c1,
					title: "Electric Blue",
					kind: "folder_patch",
					affectedPaths: ["tokens.json"],
					patchManifest: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#0070f3"}\n' }],
				},
				{
					changeId: c2,
					title: "Launch Promo",
					kind: "folder_patch",
					affectedPaths: ["promo.md"],
					previewBaseChangeIds: [c1],
					patchManifest: [{ op: "write_text", path: "promo.md", content: "# Electric Blue Promo\n" }],
				},
				{
					changeId: c3,
					title: "Sunset Orange",
					kind: "folder_patch",
					affectedPaths: ["tokens.json"],
					patchManifest: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#ff5500"}\n' }],
				},
			],
		});
		expect(chainBrief).toContain("Built on preview change(s): Change 1 (Electric Blue)");
		expect(chainBrief).toContain("# Electric Blue Promo");
		expect(chainBrief).toContain("Dependent change patch operations");

		const omitted = parseSurfaceOmittedBaseChanges([
			{
				changeId: c1,
				title: "Electric Blue",
				summary: "Added Electric Blue token",
				kind: "folder_patch",
				status: "discarded",
				affectedPaths: ["tokens.json"],
				patchManifest: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#0070f3"}\n' }],
			},
		]);
		const standaloneBrief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "identity",
			surfaceTitle: "Identity",
			sourceKind: "folder",
			isInternalReconciliation: true,
			briefMarkdown: null,
			folderRoot: "identity",
			omittedBaseChanges: omitted,
			conflictPaths: ["promo.md"],
			conflictDetails: [
				{
					changeId: c2,
					title: "Launch Promo",
					kind: "folder_patch",
					affectedPaths: ["promo.md"],
					previewBaseChangeIds: [c1],
					patchManifest: [{ op: "write_text", path: "promo.md", content: "# Electric Blue Promo\n" }],
				},
			],
		});
		expect(standaloneBrief).toContain("### Omitted Preview Base Changes");
		expect(standaloneBrief).toContain("Electric Blue (discarded)");
		expect(standaloneBrief).toContain(
			"WITHOUT relying on anything introduced only by the Omitted Preview Base Changes",
		);
	});

	it("falls back to live reads for oversized merge_json files and over-cap path counts without fabricating baseFiles", async () => {
		const c1 = randomUUID();
		const bigLiveContent = JSON.stringify({
			existing: "keep-me",
			padding: "x".repeat(140 * 1024),
		});
		const liveFiles: Record<string, string> = {
			"identity/big.json": bigLiveContent,
			"identity/small.md": "Small live\n",
		};
		const liveReader = {
			async readText(path: string, maxBytes: number) {
				const text = liveFiles[path];
				if (text === undefined) return null;
				if (Buffer.byteLength(text, "utf8") > maxBytes) {
					throw new CloudCompanyPathNotText("Company folder file is larger than text here");
				}
				return { text };
			},
		};

		const overlay = createSurfaceFolderPreviewOverlay({
			folderRoot: "identity",
			previewBaseChanges: [
				{
					changeId: c1,
					title: "Patch big JSON and small doc",
					summary: "Touches oversized JSON and small markdown",
					kind: "folder_patch",
					parentSha: null,
					headSha: null,
					affectedPaths: ["big.json", "small.md"],
					previewBaseChangeIds: [],
					patchManifest: [
						{ op: "merge_json", path: "big.json", patch: { accent: "#0070f3" } },
						{ op: "write_text", path: "small.md", content: "Small preview\n" },
					],
					baseFiles: null,
				},
			],
			liveReader,
		});
		expect(overlay).not.toBeNull();
		const signal = new AbortController().signal;
		const status = await overlay!.prepare(signal);
		expect(status.status).toBe("ready");
		expect(status.skippedPaths).toEqual(["identity/big.json"]);
		expect(await overlay!.lookup("identity/big.json", signal)).toBeNull();
		const small = await overlay!.lookup("identity/small.md", signal);
		expect(small?.kind).toBe("file");
		if (small?.kind === "file") expect(small.content).toBe("Small preview\n");

		const wrapped = overlay!.wrapTextReader(liveReader);
		await expect(wrapped.readText("identity/big.json", 128 * 1024, signal)).rejects.toThrow(CloudCompanyPathNotText);
		const bigFull = await wrapped.readText("identity/big.json", 256 * 1024, signal);
		expect(bigFull).toEqual({ text: bigLiveContent });

		const stagedRequests: unknown[] = [];
		let seenBrief = "";
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Update big.json",
				previewBaseChanges: [
					{
						changeId: c1,
						title: "Patch big JSON",
						summary: "Touches oversized JSON",
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						affectedPaths: ["big.json", "small.md"],
						previewBaseChangeIds: [],
						patchManifest: [
							{ op: "merge_json", path: "big.json", patch: { accent: "#0070f3" } },
							{ op: "write_text", path: "small.md", content: "Small preview\n" },
						],
						baseFiles: null,
					},
				],
			},
			{
				folder: liveReader,
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					seenBrief = req.turnBrief;
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Edit big json",
						summary: "Merge extra key",
						ops: [{ op: "merge_json", path: "big.json", patch: { secondary: "#111" } }],
					});
					await patchTool.execute(parsed, {
						companyId: randomUUID(),
						runId: randomUUID(),
						signal: req.signal,
					} as never);
					return { state: "ready", replyText: "Staged" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);
		expect(seenBrief).toContain("exceeded overlay read limits");
		expect(seenBrief).toContain("identity/big.json");
		expect((stagedRequests[0] as { baseFiles?: Record<string, string | null> }).baseFiles).toBeUndefined();

		const manyFiles: Record<string, string> = {};
		const manyOps: { op: "merge_json"; path: string; patch: Record<string, unknown> }[] = [];
		for (let i = 1; i <= 50; i += 1) {
			const rel = `doc-${String(i).padStart(2, "0")}.json`;
			manyFiles[`identity/${rel}`] = JSON.stringify({ live: i });
			manyOps.push({ op: "merge_json", path: rel, patch: { staged: i } });
		}
		const capOverlay = createSurfaceFolderPreviewOverlay({
			folderRoot: "identity",
			previewBaseChanges: [
				{
					changeId: randomUUID(),
					title: "Many files",
					summary: "50 json patches",
					kind: "folder_patch",
					parentSha: null,
					headSha: null,
					affectedPaths: manyOps.map((op) => op.path),
					previewBaseChangeIds: [],
					patchManifest: manyOps,
					baseFiles: null,
				},
			],
			liveReader: {
				async readText(path: string) {
					return manyFiles[path] !== undefined ? { text: manyFiles[path]! } : null;
				},
			},
		});
		const capStatus = await capOverlay!.prepare(signal);
		expect(capStatus.status).toBe("ready");
		expect(capStatus.skippedPaths).toEqual(["identity/doc-49.json", "identity/doc-50.json"]);
		const doc48 = await capOverlay!.lookup("identity/doc-48.json", signal);
		expect(doc48?.kind).toBe("file");
		if (doc48?.kind === "file") expect(JSON.parse(doc48.content)).toEqual({ live: 48, staged: 48 });
		expect(await capOverlay!.lookup("identity/doc-49.json", signal)).toBeNull();
		expect(await capOverlay!.lookup("identity/doc-50.json", signal)).toBeNull();
	});

	it("drops the overlay to live reads and notes it in turn brief when preview bases conflict", async () => {
		const c1 = randomUUID();
		const c2 = randomUUID();
		const liveReader = {
			async readText(path: string) {
				if (path === "identity/tokens.json") return { text: '{"accent":"#222222"}\n' };
				return null;
			},
		};
		const conflictingChanges = [
			{
				changeId: c1,
				title: "Electric Blue",
				summary: "Blue accent",
				kind: "folder_patch",
				parentSha: null,
				headSha: null,
				affectedPaths: ["tokens.json", "promo.md"],
				previewBaseChangeIds: [],
				patchManifest: [
					{ op: "write_text" as const, path: "tokens.json", content: '{"accent":"#0070f3"}\n' },
					{ op: "write_text" as const, path: "promo.md", content: "# Blue Promo\n" },
				],
				baseFiles: { "tokens.json": '{"accent":"#222222"}\n' },
			},
			{
				changeId: c2,
				title: "Sunset Orange",
				summary: "Orange accent",
				kind: "folder_patch",
				parentSha: null,
				headSha: null,
				affectedPaths: ["tokens.json"],
				previewBaseChangeIds: [],
				patchManifest: [{ op: "write_text" as const, path: "tokens.json", content: '{"accent":"#ff5500"}\n' }],
				baseFiles: { "tokens.json": '{"accent":"#222222"}\n' },
			},
		];

		const overlay = createSurfaceFolderPreviewOverlay({
			folderRoot: "identity",
			previewBaseChanges: conflictingChanges,
			liveReader,
		});
		const signal = new AbortController().signal;
		const status = await overlay!.prepare(signal);
		expect(status.status).toBe("conflicted");
		expect(await overlay!.lookup("identity/tokens.json", signal)).toBeNull();
		expect(await overlay!.lookup("identity/promo.md", signal)).toBeNull();

		const stagedRequests: unknown[] = [];
		let seenBrief = "";
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Refine tokens",
				previewBaseChanges: conflictingChanges,
			},
			{
				folder: liveReader,
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					seenBrief = req.turnBrief;
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Refine tokens",
						summary: "Updates tokens from live",
						ops: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#333333"}\n' }],
					});
					await patchTool.execute(parsed, {
						companyId: randomUUID(),
						runId: randomUUID(),
						signal: req.signal,
					} as never);
					return { state: "ready", replyText: "Staged" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);
		expect(seenBrief).toContain("currently overlap and are reconciling");
		expect(seenBrief).toContain("reading the current published live files instead of a partial preview");
		expect((stagedRequests[0] as { baseFiles?: Record<string, string | null> }).baseFiles).toEqual({
			"tokens.json": '{"accent":"#222222"}\n',
		});
	});
});
