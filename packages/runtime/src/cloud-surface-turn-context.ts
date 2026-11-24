import {
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	type PointToChangeTarget,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	parseStudioPatchOps,
	type StudioPatchOp,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
	type SurfaceSourceKind,
} from "@qorpera/contracts";
import {
	type SurfaceAttachmentReader,
	type SurfaceMemberImage,
	surfaceMemberImagesSection,
} from "./cloud-surface-images.ts";
import type { SurfaceOmittedBaseChange, SurfacePreviewBaseChange } from "./cloud-surface-preview-overlay.ts";
import type { CloudSurfaceToolsPort } from "./cloud-surface-tools.ts";

export interface SurfaceIdentityContext {
	readonly briefMarkdown?: string | null;
	readonly tokensJson?: string | null;
	readonly voiceSummary?: string | null;
}

export interface SurfaceSharedAssetsContext {
	readonly tokensCss?: string | null;
	readonly companyProfileJson?: string | null;
	readonly productSpecsJson?: string | null;
	readonly productCatalogJson?: string | null;
	readonly hasLogoSvg?: boolean;
}

export interface SurfaceConflictDetail {
	readonly changeId?: string | null;
	readonly title?: string | null;
	readonly summary?: string | null;
	readonly kind?: string | null;
	readonly prompt?: string | null;
	readonly createdAt?: string | null;
	readonly sessionId?: string | null;
	readonly branch?: string | null;
	readonly parentSha?: string | null;
	readonly headSha?: string | null;
	readonly patchManifest?: readonly StudioPatchOp[] | null;
	readonly baseFiles?: Readonly<Record<string, string | null>> | null;
	readonly affectedPaths?: readonly string[] | null;
	readonly conflictPaths?: readonly string[] | null;
	readonly previewBaseChangeIds?: readonly string[] | null;
}

function parseOptionalStringMap(raw: unknown): Readonly<Record<string, string | null>> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, string | null> = {};
	let count = 0;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (value === null || typeof value === "string") {
			out[key] = value;
			count += 1;
		}
	}
	return count > 0 ? out : null;
}

function parseOptionalPatchManifest(raw: unknown): readonly StudioPatchOp[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		const ops = parseStudioPatchOps(raw, "conflictDetail.patchManifest");
		return ops.length > 0 ? ops : null;
	} catch {
		return null;
	}
}

export function parseSurfaceConflictDetails(raw: unknown): SurfaceConflictDetail[] {
	if (!Array.isArray(raw)) return [];
	const out: SurfaceConflictDetail[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		const conflictPaths = Array.isArray(item.conflictPaths)
			? item.conflictPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: null;
		const affectedPaths = Array.isArray(item.affectedPaths)
			? item.affectedPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: null;
		const previewBaseChangeIds = Array.isArray(item.previewBaseChangeIds)
			? item.previewBaseChangeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
			: null;
		out.push({
			changeId: typeof item.changeId === "string" ? item.changeId : null,
			title: typeof item.title === "string" ? item.title : null,
			summary: typeof item.summary === "string" ? item.summary : null,
			kind: typeof item.kind === "string" ? item.kind : null,
			prompt: typeof item.prompt === "string" ? item.prompt : null,
			createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
			sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
			branch: typeof item.branch === "string" ? item.branch : null,
			parentSha: typeof item.parentSha === "string" ? item.parentSha : null,
			headSha: typeof item.headSha === "string" ? item.headSha : null,
			patchManifest: parseOptionalPatchManifest(item.patchManifest),
			baseFiles: parseOptionalStringMap(item.baseFiles),
			affectedPaths,
			conflictPaths,
			...(previewBaseChangeIds && previewBaseChangeIds.length > 0 ? { previewBaseChangeIds } : {}),
		});
	}
	return out;
}

export interface SurfaceTurnOpenChange {
	readonly id: string;
	readonly title: string;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly optionGroupKey: string | null;
	readonly optionGroupTitle: string | null;
}

export function parseSurfaceTurnOpenChanges(raw: unknown): SurfaceTurnOpenChange[] {
	if (!Array.isArray(raw)) return [];
	const out: SurfaceTurnOpenChange[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		if (typeof item.id !== "string" || typeof item.title !== "string") continue;
		out.push({
			id: item.id,
			title: item.title,
			parentSha: typeof item.parentSha === "string" ? item.parentSha : null,
			headSha: typeof item.headSha === "string" ? item.headSha : null,
			optionGroupKey: typeof item.optionGroupKey === "string" ? item.optionGroupKey : null,
			optionGroupTitle: typeof item.optionGroupTitle === "string" ? item.optionGroupTitle : null,
		});
	}
	return out;
}

export interface SurfaceTurnBriefInput {
	readonly sessionId: string;
	readonly surfaceSlug: string;
	readonly surfaceTitle: string;
	readonly sourceKind?: SurfaceSourceKind;
	readonly isInternalReconciliation?: boolean;
	readonly briefMarkdown: string | null;
	readonly fullPrompt?: string | null;
	readonly repositoryKey?: string | null;
	readonly folderRoot?: string | null;
	readonly explorationVariantLabel?: string | null;
	readonly identityContext?: SurfaceIdentityContext | null;
	readonly sharedAssets?: SurfaceSharedAssetsContext | null;
	readonly pointToChangeTarget?: PointToChangeTarget | null;
	readonly conflictPaths?: readonly string[] | null;
	readonly conflictDetails?: readonly SurfaceConflictDetail[] | null;
	readonly previewBaseChanges?: readonly SurfacePreviewBaseChange[] | null;
	readonly previewOverlayStatus?: "ready" | "conflicted" | "truncated" | null;
	readonly previewSkippedPaths?: readonly string[] | null;
	readonly chainMode?: boolean;
	readonly omittedBaseChanges?: readonly SurfaceOmittedBaseChange[] | null;
	readonly mainSha?: string | null;
	readonly branchHeadSha?: string | null;
	readonly openChanges?: readonly SurfaceTurnOpenChange[] | null;
	readonly recordChange?: CloudSurfaceToolsPort["recordChange"];
	readonly memberImages?: readonly SurfaceMemberImage[] | null;
	readonly viewAttachment?: SurfaceAttachmentReader;
}

export interface SurfaceCodingTurnBinding extends SurfaceTurnBriefInput {
	readonly recordChange: CloudSurfaceToolsPort["recordChange"];
}

export const SURFACE_STAGED_CODING_INSTRUCTIONS =
	"IMPORTANT — Surface Staged Mode: " +
	"This session is scoped to a Qorpera Surface — a direct live projection of its codebase or Company Files folder. " +
	"Commits you make on this session branch stay STAGED for founder Preview and approval and do NOT land on main until the founder approves them. " +
	"Founders preview multiple unmerged staged changes from concurrent sessions toggled on or off simultaneously in Preview before approving or publishing any of them. " +
	"Preview renders static web assets from site.folder in .qorpera/checks.json, from index.html at the repository root, from dist/build/out/public, or from apps/<repo>*/index.html — make sure a clean servable index.html and its assets are committed on the session branch (commit the built output folder if you use a bundler, and set site.folder to it when needed). " +
	"Every staged commit MUST be a real, publishable website or app — NEVER embed a concept switcher, A/B/C option bar, comparison view, or design-question UI into the page itself. " +
	"When the founder asks for multiple design ideas, website directions, or a multiple choice to flick through, build each direction as its own real, standalone publishable version and stage each commit with coding_record_change using the same optionGroup slug (and optional optionGroupTitle) and the same shared parentSha (capture BASE=$(git rev-parse HEAD) before option 1). Between options, reset the working tree and index cleanly to $BASE with `git read-tree --reset -u $BASE` (and remove any untracked scratch files) without moving HEAD, then build and commit the next option so HEAD advances linearly on the session branch with zero file bleed between options; each option then appears in the Changes sidebar as a multiple-choice picker where the founder can flick through real previews, unselect all, and keep one before approving. " +
	'A .qorpera/checks.json file is optional for simple static Surfaces; for multi-file codebases, run .qorpera/checks.json pre-flight via coding_run_command (runChecks: true) before coding_finish, and optionally set "surfaceGate": "stage" in .qorpera/checks.json to enforce checks automatically before staging (default "none" keeps Preview staging instant). ' +
	"Keep each staged change atomic, self-contained, and conflict-minimizing: touch only the files needed for this deliverable and avoid unrequested sweeping refactors across shared files. " +
	"For each cohesive user-visible deliverable you complete, commit cleanly on the current branch and call coding_record_change with a plain founder-facing title, short summary, parentSha, and commitSha before moving to the next change. " +
	"When all requested deliverables are committed and verified, call coding_finish with the final headSha to stage the session as ready for review.";

// WHY: Injects global company Identity assets, Surface domain taste (brief.md), Point-to-Change DOM context, and conflict paths directly into scoped coding turns.
export function buildSurfaceTurnBrief(binding: SurfaceTurnBriefInput): string {
	const headerLines = [
		`# Surface Context: ${binding.surfaceTitle} (${binding.surfaceSlug})`,
		`Session ID: ${binding.sessionId}`,
	];
	const repositoryKey = binding.repositoryKey?.trim();
	const folderRoot = binding.folderRoot?.trim();
	const explorationVariantLabel = binding.explorationVariantLabel?.trim();
	if (repositoryKey) headerLines.push(`Repository: code/${repositoryKey}`);
	if (folderRoot) headerLines.push(`Folder root: ${folderRoot}`);
	if (explorationVariantLabel) headerLines.push(`Exploration direction: ${explorationVariantLabel}`);

	const isFolderOnly = Boolean(folderRoot && !repositoryKey);
	const sections: string[] = [
		headerLines.join("\n"),
		isFolderOnly
			? "## Surface Projection & Parallel Preview\n" +
				"This Surface projects its Company Files folder directly into live Preview. " +
				"Founders can toggle multiple unmerged staged changes from concurrent sessions on and off together in Preview before approving them. " +
				(binding.isInternalReconciliation
					? "This is an internal reconciliation turn: submit one `stage_surface_patch` call covering every overlapping file listed below."
					: "Keep each staged change atomic, self-contained, and conflict-minimizing: stage one `stage_surface_patch` call per independent deliverable (for example, one change per report, article, blog post, or layout/section update) rather than bundling unrelated deliverables into a single change.")
			: "## Surface Projection & Parallel Preview\n" +
				"This Surface projects its underlying codebase or Company Files folder directly into the live Preview (resolving `site.folder` from `.qorpera/checks.json`, root `index.html`, `dist`/`build`/`out`/`public`, or `apps/<repo>*/index.html`; commit the built output folder when using a bundler). " +
				"Founders can toggle multiple unmerged staged changes from concurrent sessions on and off together in Preview before approving or publishing them. " +
				'For multi-file codebases, verify changes pre-flight with `coding_run_command` (`runChecks: true` when `.qorpera/checks.json` exists; opt into `"surfaceGate": "stage"` to enforce checks automatically on `coding_finish`, or leave default `"none"` for instant Preview staging). ' +
				"Keep each staged change atomic, self-contained, and conflict-minimizing — touch only the files required for your deliverable and avoid unnecessary edits to unrelated shared files.",
	];

	if (explorationVariantLabel) {
		sections.push(
			`## Exploration Direction: ${explorationVariantLabel}\nDeliver ONLY this single direction as a real, publishable page so founders can compare side-by-side variants cleanly in Preview. Never embed an in-page concept switcher, A/B/C bar, or option picker even if the prompt mentions comparing multiple ideas.`,
		);
	}

	const openChanges = binding.openChanges ?? [];
	const branchHeadSha = binding.branchHeadSha?.trim() || null;
	const mainSha = binding.mainSha?.trim() || null;
	if (binding.repositoryKey && !binding.isInternalReconciliation) {
		if (openChanges.length > 0) {
			const latestOpen = openChanges[openChanges.length - 1];
			const lines = [
				"## Active Staged Changes on This Session",
				...openChanges.map(
					(ch) =>
						`- ${ch.title}${ch.optionGroupKey ? ` (optionGroup: ${ch.optionGroupKey})` : ""}${ch.headSha ? ` · commit \`${ch.headSha}\`` : ""}`,
				),
			];
			if (latestOpen?.headSha && branchHeadSha && latestOpen.headSha !== branchHeadSha) {
				lines.push(
					`Note: the session branch tip (\`${branchHeadSha}\`) is past the active chosen commit (\`${latestOpen.headSha}\`), likely because a later option was discarded. Before making follow-up edits, run \`git read-tree --reset -u ${latestOpen.headSha}\` (keeping HEAD on the branch tip) so your new commit builds on the chosen option, and pass \`parentSha: "${latestOpen.headSha}"\` to \`coding_record_change\`.`,
				);
			}
			sections.push(lines.join("\n"));
		} else if (branchHeadSha && mainSha && branchHeadSha !== mainSha) {
			sections.push(
				`## Session Branch Sync\nNote: this session has no open staged changes, and the session branch tip (\`${branchHeadSha}\`) differs from \`main\` (\`${mainSha}\`), likely because prior changes or options were approved or discarded. Before making new edits, run \`git read-tree --reset -u ${mainSha}\` (keeping HEAD on the branch tip) so your new commit starts cleanly from \`main\`, and pass \`parentSha: "${mainSha}"\` to \`coding_record_change\`.`,
			);
		}
	}

	const fullPrompt = binding.fullPrompt?.trim();
	if (fullPrompt && fullPrompt.length > 1400) {
		sections.push(`## Full Surface Request\n${fullPrompt.slice(0, 16000)}`);
	}

	const identity = binding.identityContext;
	if (identity) {
		const identityParts: string[] = [];
		const identityBrief = identity.briefMarkdown?.trim();
		const identityVoice = identity.voiceSummary?.trim();
		const identityTokens = identity.tokensJson?.trim();
		if (identityBrief) {
			identityParts.push(`### Brand & Philosophy\n${identityBrief.slice(0, 4000)}`);
		}
		if (identityVoice) {
			identityParts.push(`### Voice & Tone\n${identityVoice.slice(0, 2000)}`);
		}
		if (identityTokens) {
			identityParts.push(`### Design Tokens\n\`\`\`json\n${identityTokens.slice(0, 4000)}\n\`\`\``);
		}
		if (identityParts.length > 0) {
			sections.push(
				`## Global Company Identity\nApply the company's global brand, voice, and design tokens across this surface unless the member explicitly asks to diverge.\n\n${identityParts.join("\n\n")}`,
			);
		}
	}

	const isIdentitySurface = binding.surfaceSlug === "identity";
	const sharedLines = isIdentitySurface
		? [
				"## Live Shared Company Files",
				`- **Visual Identity CSS Live Sync:** Changes you stage to \`${IDENTITY_TOKENS_JSON_PATH}\` automatically recompile \`${IDENTITY_TOKENS_CSS_PATH}\` and flow live as \`${SURFACE_IDENTITY_CSS_MOUNT_PATH}\` CSS custom properties (\`--q-color-*\`, \`--q-font-*\`, \`--q-radius-*\`, \`--q-space-*\`) into every downstream surface with zero manual copy-paste.`,
				`- **Shared Company Data:** Keep canonical company details in \`${IDENTITY_COMPANY_PATH}\` and the vector mark in \`${IDENTITY_LOGO_PATH}\` so downstream surfaces consume them from \`${SURFACE_SHARED_DIR}/\` automatically.`,
			]
		: [
				"## Live Shared Company Files",
				`- **Visual Identity CSS Live Sync:** Never hardcode brand colors, fonts, or radii in Website, Web App, or Mobile App — style directly with CSS custom properties from \`${SURFACE_IDENTITY_CSS_MOUNT_PATH}\` (\`var(--q-color-primary)\`, \`var(--q-color-accent)\`, \`var(--q-color-surface)\`, \`var(--q-color-muted)\`, \`var(--q-font-heading)\`, \`var(--q-font-body)\`, \`var(--q-radius-*)\`), which auto-compiles from \`${IDENTITY_TOKENS_JSON_PATH}\` so any approved Identity change flows live everywhere with zero rebuild or re-edit.`,
				`- **Shared Product & Company Data:** Consume \`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}\`, \`${SURFACE_SHARED_DIR}/${PRODUCT_CATALOG_PATH}\`, and \`${SURFACE_SHARED_DIR}/${IDENTITY_COMPANY_PATH}\` whenever present rather than hardcoding prices, SKUs, specs, or company contact info across surfaces.`,
			];
	const sharedExcerpts: string[] = [];
	const shared = binding.sharedAssets;
	if (shared) {
		if (shared.hasLogoSvg) {
			sharedLines.push(
				`- **Shared Brand Logo:** Available at \`${SURFACE_SHARED_DIR}/${IDENTITY_LOGO_PATH}\` (canonical path \`${IDENTITY_LOGO_PATH}\`).`,
			);
		}
		const tokensCss = shared.tokensCss?.trim();
		if (tokensCss && !isIdentitySurface) {
			sharedExcerpts.push(
				`### Compiled Identity CSS (\`${SURFACE_IDENTITY_CSS_MOUNT_PATH}\`)\n\`\`\`css\n${tokensCss.slice(0, 2500)}\n\`\`\``,
			);
		}
		const companyProfileJson = shared.companyProfileJson?.trim();
		if (companyProfileJson) {
			sharedExcerpts.push(
				`### Shared Company Profile (\`${SURFACE_SHARED_DIR}/${IDENTITY_COMPANY_PATH}\`)\n\`\`\`json\n${companyProfileJson.slice(0, 2500)}\n\`\`\``,
			);
		}
		const productSpecsJson = shared.productSpecsJson?.trim();
		if (productSpecsJson) {
			sharedExcerpts.push(
				`### Shared Product Specs (\`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}\`)\n\`\`\`json\n${productSpecsJson.slice(0, 3000)}\n\`\`\``,
			);
		}
		const productCatalogJson = shared.productCatalogJson?.trim();
		if (productCatalogJson) {
			sharedExcerpts.push(
				`### Shared Product Catalog (\`${SURFACE_SHARED_DIR}/${PRODUCT_CATALOG_PATH}\`)\n\`\`\`json\n${productCatalogJson.slice(0, 3000)}\n\`\`\``,
			);
		}
	}
	sections.push(
		sharedExcerpts.length > 0
			? `${sharedLines.join("\n")}\n\n${sharedExcerpts.join("\n\n")}`
			: sharedLines.join("\n"),
	);

	const brief = binding.briefMarkdown?.trim();
	if (brief) {
		sections.push(`## Surface Brief (QorperaOS/surfaces/${binding.surfaceSlug}/brief.md)\n${brief.slice(0, 8000)}`);
	}

	const target = binding.pointToChangeTarget;
	if (target) {
		const lines = [
			"## Point-to-Change Target",
			`- Route: ${target.route}`,
			`- Selector: ${target.selector}`,
			`- Element: <${target.tagName}>${target.componentHint ? ` (${target.componentHint})` : ""}`,
		];
		if (target.textSnippet.trim()) lines.push(`- Text snippet: "${target.textSnippet.trim()}"`);
		lines.push(`- Viewport: ${target.viewport.width}x${target.viewport.height}`);
		sections.push(lines.join("\n"));
	}

	const previewBaseChanges = binding.previewBaseChanges ?? [];
	if (!binding.isInternalReconciliation && previewBaseChanges.length > 0) {
		const isFolderSurface = binding.sourceKind === "folder";
		const skippedPaths = (binding.previewSkippedPaths ?? []).filter((p) => p.trim().length > 0);
		const truncatedCount = previewBaseChanges.filter((item) => item.truncated === true).length;
		const folderRootLabel = folderRoot || binding.surfaceSlug;
		const folderIntro =
			binding.previewOverlayStatus === "conflicted"
				? `The member started this request while viewing Preview with ${previewBaseChanges.length} unmerged staged change${previewBaseChanges.length === 1 ? "" : "s"} active. Those preview changes currently overlap and are reconciling, so \`company_read\` and \`company_list\` under \`${folderRootLabel}/\` are reading the current published live files instead of a partial preview. Keep your edits atomic and touch only the files needed for this request.`
				: binding.previewOverlayStatus === "truncated" ||
						(binding.previewOverlayStatus == null && truncatedCount > 0)
					? `The member started this request while viewing Preview with ${previewBaseChanges.length} unmerged staged change${previewBaseChanges.length === 1 ? "" : "s"} active. Their patch manifests exceeded the turn context budget, so \`company_read\` and \`company_list\` under \`${folderRootLabel}/\` are reading the current published live files instead. Keep your edits atomic and touch only the files needed for this request.`
					: `The member started this request while viewing Preview with ${previewBaseChanges.length} unmerged staged change${previewBaseChanges.length === 1 ? "" : "s"} active. \`company_read\` and \`company_list\` under \`${folderRootLabel}/\` already reflect this preview state. Build cleanly on top of what is visible in Preview, and touch only the files needed for this request.${
							skippedPaths.length > 0
								? ` Note: ${skippedPaths.length} preview-touched path${skippedPaths.length === 1 ? "" : "s"} exceeded overlay read limits and ${skippedPaths.length === 1 ? "is" : "are"} reading published live files instead (${skippedPaths.slice(0, 12).join(", ")}${skippedPaths.length > 12 ? `, +${skippedPaths.length - 12} more` : ""}).`
								: ""
						}`;
		const lines: string[] = [
			"## Active Preview Changes",
			isFolderSurface
				? folderIntro
				: `The member started this request while viewing Preview with ${previewBaseChanges.length} unmerged staged change${previewBaseChanges.length === 1 ? "" : "s"} active. Inspect any relevant staged commits via \`git show <sha>\` or \`git diff <parent>..<head>\` so your work aligns cleanly while staying atomic on this session branch.`,
		];
		const maxPreviewChanges = 20;
		for (let i = 0; i < Math.min(previewBaseChanges.length, maxPreviewChanges); i += 1) {
			const item = previewBaseChanges[i]!;
			const parts: string[] = [`${i + 1}. ${item.title.slice(0, 160)}`];
			if (!isFolderSurface) {
				if (item.parentSha && item.headSha) {
					parts.push(`range \`${item.parentSha.slice(0, 40)}..${item.headSha.slice(0, 40)}\``);
				} else if (item.headSha) {
					parts.push(`commit \`${item.headSha.slice(0, 40)}\``);
				}
			}
			if (item.affectedPaths.length > 0) {
				parts.push(`paths: ${item.affectedPaths.slice(0, 12).join(", ")}`);
			}
			if (item.summary) {
				parts.push(`summary: ${item.summary.slice(0, 240)}`);
			}
			lines.push(`- ${parts.join(" · ")}`);
		}
		if (previewBaseChanges.length > maxPreviewChanges) {
			lines.push(`- ...and ${previewBaseChanges.length - maxPreviewChanges} more active preview changes`);
		}
		sections.push(lines.join("\n"));
	}

	const conflictPaths = binding.conflictPaths?.filter((p) => p.trim().length > 0) ?? [];
	const conflictDetails = binding.conflictDetails ?? [];
	const omittedBaseChanges = binding.omittedBaseChanges ?? [];
	const chainMode = binding.chainMode === true;
	if (conflictPaths.length > 0 || conflictDetails.length > 0 || omittedBaseChanges.length > 0) {
		const isFolderReconcile =
			binding.sourceKind === "folder" ||
			conflictDetails.some((detail) => detail.kind === "folder_patch" || Array.isArray(detail.patchManifest));
		const detailIndexById = new Map<string, { readonly index: number; readonly title: string }>();
		for (let i = 0; i < conflictDetails.length; i += 1) {
			const detail = conflictDetails[i];
			if (detail?.changeId) {
				detailIndexById.set(detail.changeId, {
					index: i + 1,
					title: detail.title?.trim() || detail.changeId,
				});
			}
		}
		const lines: string[] = ["## Conflict Reconciliation"];
		if (isFolderReconcile) {
			const rootLabel = folderRoot || binding.surfaceSlug;
			const normalizeRelativePath = (rawPath: string): string => {
				const cleaned = rawPath.trim().replace(/^\/+|\/+$/g, "");
				if (rootLabel && cleaned.startsWith(`${rootLabel}/`)) {
					return cleaned.slice(rootLabel.length + 1);
				}
				return cleaned;
			};
			const conflictPathSet = new Set(conflictPaths.map(normalizeRelativePath).filter((p) => p.length > 0));
			lines.push(
				`Target Studio folder: \`${rootLabel}/\``,
				"Staged changes to combine in chronological order (oldest first; higher number is newer):",
			);
			const maxDetails = 25;
			for (let i = 0; i < Math.min(conflictDetails.length, maxDetails); i += 1) {
				const detail = conflictDetails[i];
				if (!detail) continue;
				const label = detail.title?.trim() || detail.changeId?.trim() || "Staged change";
				lines.push(`### Change ${i + 1}: ${label.slice(0, 160)}`);
				const detailPrompt = detail.prompt?.trim();
				if (detailPrompt) lines.push(`- Original request: ${detailPrompt.slice(0, 1000)}`);
				const detailSummary = detail.summary?.trim();
				if (detailSummary) lines.push(`- Summary: ${detailSummary.slice(0, 500)}`);
				const baseRefs = (detail.previewBaseChangeIds ?? [])
					.map((id) => {
						const match = detailIndexById.get(id);
						return match ? `Change ${match.index} (${match.title.slice(0, 80)})` : null;
					})
					.filter((value): value is string => value !== null);
				const isDependentInChain = chainMode && baseRefs.length > 0;
				if (baseRefs.length > 0) {
					lines.push(`- Built on preview change(s): ${baseRefs.join(", ")}`);
				}
				const detailPaths =
					detail.affectedPaths?.filter((p) => p.trim().length > 0) ??
					detail.conflictPaths?.filter((p) => p.trim().length > 0) ??
					[];
				if (detailPaths.length > 0) {
					lines.push(`- Paths: ${detailPaths.slice(0, 40).join(", ")}`);
				}
				if (detail.patchManifest && detail.patchManifest.length > 0) {
					const relevantOps: unknown[] = [];
					const preservedPaths: string[] = [];
					for (const rawOp of detail.patchManifest) {
						const opRecord =
							rawOp && typeof rawOp === "object" && !Array.isArray(rawOp)
								? (rawOp as Record<string, unknown>)
								: null;
						const opPath = typeof opRecord?.path === "string" ? opRecord.path : "";
						const opKind = typeof opRecord?.op === "string" ? opRecord.op : "";
						const relPath = normalizeRelativePath(opPath);
						if (!isDependentInChain && conflictPathSet.size > 0 && relPath && !conflictPathSet.has(relPath)) {
							preservedPaths.push(opPath);
							continue;
						}
						if (opKind === "write_file" && (conflictPathSet.size === 0 || !conflictPathSet.has(relPath))) {
							preservedPaths.push(opPath);
							continue;
						}
						relevantOps.push(rawOp);
					}
					if (preservedPaths.length > 0) {
						lines.push(
							`- Non-conflicting paths (preserved automatically from this change; no need to re-emit): ${[...new Set(preservedPaths)].join(", ")}`,
						);
					}
					if (relevantOps.length > 0) {
						lines.push(
							isDependentInChain
								? "Dependent change patch operations (inspect and emit updated ops if needed to stay consistent with modifications to its base change; untouched files are preserved automatically):"
								: "Staged patch operations for overlapping files (complete, untruncated):",
							"```json",
							JSON.stringify(relevantOps, null, 2),
							"```",
						);
					}
				}
			}
			if (conflictDetails.length > maxDetails) {
				lines.push(`- ...and ${conflictDetails.length - maxDetails} more staged changes`);
			}
			if (omittedBaseChanges.length > 0) {
				lines.push("### Omitted Preview Base Changes (removed or toggled off — NOT active in this variant)");
				for (const omitted of omittedBaseChanges.slice(0, 12)) {
					lines.push(`- ${omitted.title.slice(0, 160)} (${omitted.status})`);
					if (omitted.summary) lines.push(`  - Summary: ${omitted.summary.slice(0, 400)}`);
					if (omitted.affectedPaths.length > 0) {
						lines.push(`  - Paths: ${omitted.affectedPaths.slice(0, 24).join(", ")}`);
					}
					if (omitted.patchManifest && omitted.patchManifest.length > 0) {
						const textOps = omitted.patchManifest.filter((op) => op.op !== "write_file");
						if (textOps.length > 0) {
							lines.push("```json", JSON.stringify(textOps, null, 2), "```");
						}
					}
				}
			}
			if (conflictPaths.length > 0) {
				const maxConflictPaths = 100;
				lines.push("Overlapping files that must be covered in your staged patch:");
				const shown = conflictPaths.slice(0, maxConflictPaths).map((path) => `- ${path.slice(0, 256)}`);
				const overflow = conflictPaths.length - shown.length;
				if (overflow > 0) {
					shown.push(`- ...and ${overflow} more paths`);
				}
				lines.push(...shown);
			}
			lines.push(
				"Reconciliation procedure:",
				`1. Read the current published files under \`${rootLabel}/\` via \`company_read\` as needed for full context.`,
				omittedBaseChanges.length > 0
					? "2. Adapt the staged change(s) above to stand cleanly on the current published files WITHOUT relying on anything introduced only by the Omitted Preview Base Changes above (update references, names, tokens, or copy as needed while preserving the change's core goal)."
					: chainMode
						? "2. Combine the overlapping staged changes into one cohesive set of `StudioPatchOp` operations (`write_text`, `merge_json`, `delete`) covering every overlapping file listed above, AND inspect all downstream dependent changes that built on a modified base change — emit updated ops for any dependent files whose references, tokens, or copy must match the newer modifications. Files you do not re-emit are preserved automatically."
						: "2. Combine the overlapping staged changes into one cohesive set of `StudioPatchOp` operations (`write_text`, `merge_json`, `delete`) covering every overlapping file listed above and preserving all compatible edits, markdown sections, SVG markup, and JSON tokens. Non-conflicting files from the staged changes are preserved automatically.",
				"3. If two changes directly contradict on the exact same value, sentence, or visual choice, prefer the newer change (higher Change number) unless the later request clearly intended to preserve both.",
				"4. Call `stage_surface_patch` once with complete, untruncated operations covering every required file listed above, then call `surface_reply` with a brief summary. Never ask the founder questions.",
			);
		} else {
			const mainSha = binding.mainSha?.trim();
			if (mainSha) {
				lines.push(`Target main SHA: \`${mainSha.slice(0, 64)}\``);
			}
			if (conflictDetails.length > 0) {
				lines.push("Conflicting staged changes to reconcile (oldest first; higher number is newer):");
				const maxDetails = 25;
				for (let i = 0; i < Math.min(conflictDetails.length, maxDetails); i += 1) {
					const detail = conflictDetails[i];
					if (!detail) continue;
					const label = detail.title?.trim() || detail.changeId?.trim() || "Staged change";
					const parts: string[] = [`#${i + 1} ${label.slice(0, 160)}`];
					const baseRefs = (detail.previewBaseChangeIds ?? [])
						.map((id) => {
							const match = detailIndexById.get(id);
							return match ? `#${match.index}` : null;
						})
						.filter((value): value is string => value !== null);
					if (baseRefs.length > 0) {
						parts.push(`built on ${baseRefs.join(", ")}`);
					}
					const branch = detail.branch?.trim();
					if (branch) parts.push(`branch \`${branch.slice(0, 120)}\``);
					const parentSha = detail.parentSha?.trim();
					const headSha = detail.headSha?.trim();
					if (parentSha && headSha) {
						parts.push(`range \`${parentSha.slice(0, 40)}..${headSha.slice(0, 40)}\``);
					} else if (headSha) {
						parts.push(`commit \`${headSha.slice(0, 40)}\``);
					}
					const detailPaths = detail.conflictPaths?.filter((p) => p.trim().length > 0) ?? [];
					if (detailPaths.length > 0) {
						parts.push(`paths: ${detailPaths.slice(0, 10).join(", ")}`);
					}
					const detailSummary = detail.summary?.trim();
					if (detailSummary) {
						parts.push(`summary: ${detailSummary.slice(0, 200)}`);
					}
					const detailPrompt = detail.prompt?.trim();
					if (detailPrompt) {
						parts.push(`request: ${detailPrompt.slice(0, 300)}`);
					}
					lines.push(`- ${parts.join(" · ")}`);
				}
				if (conflictDetails.length > maxDetails) {
					lines.push(`- ...and ${conflictDetails.length - maxDetails} more conflicting changes`);
				}
			}
			if (omittedBaseChanges.length > 0) {
				lines.push("Omitted preview base changes (removed or toggled off — NOT included in this variant):");
				for (const omitted of omittedBaseChanges.slice(0, 12)) {
					const parts: string[] = [`${omitted.title.slice(0, 160)} (${omitted.status})`];
					if (omitted.parentSha && omitted.headSha) {
						parts.push(`range \`${omitted.parentSha.slice(0, 40)}..${omitted.headSha.slice(0, 40)}\``);
					} else if (omitted.headSha) {
						parts.push(`commit \`${omitted.headSha.slice(0, 40)}\``);
					}
					if (omitted.affectedPaths.length > 0) {
						parts.push(`paths: ${omitted.affectedPaths.slice(0, 10).join(", ")}`);
					}
					lines.push(`- ${parts.join(" · ")}`);
				}
			}
			if (conflictPaths.length > 0) {
				const maxConflictPaths = 100;
				lines.push("Conflicted files:");
				const shown = conflictPaths.slice(0, maxConflictPaths).map((path) => `- ${path.slice(0, 256)}`);
				const overflow = conflictPaths.length - shown.length;
				if (overflow > 0) {
					shown.push(`- ...and ${overflow} more paths`);
				}
				lines.push(...shown);
			}
			lines.push(
				"Reconciliation procedure:",
				"1. Inspect current `main` (`git log -n 5 main`) and integrate your branch cleanly with `git merge main` or apply each conflicting range with `git cherry-pick <parentSha>..<headSha>`.",
				binding.isInternalReconciliation
					? omittedBaseChanges.length > 0
						? "2. Adapt the listed change(s) so they build and work cleanly on `main` WITHOUT relying on anything from the omitted preview base changes. Never call `coding_ask`."
						: chainMode
							? "2. Inspect every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) AND inspect all downstream dependent changes (`built on #...`) so their imports, props, tokens, and references stay consistent with the newer modifications. Preserve all compatible behavior; if two changes directly contradict on the exact same choice, prefer the newer change (higher #). Never call `coding_ask`."
							: "2. Inspect every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) across the conflicted files. Preserve all compatible behavior from every listed change; if two changes directly contradict on the exact same choice, prefer the newer change (higher #). Never call `coding_ask`."
					: "2. Inspect every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) across the conflicted files and preserve the intent of each change cleanly without dropping behavior.",
				"3. Run the repository's build and test checks (`coding_run_command` with `runChecks: true` when `.qorpera/checks.json` exists, plus targeted tests) to verify the reconciled code passes.",
				"4. Commit the clean resolution on the session branch, call `coding_record_change` with the resolved commit range, and finish with `coding_finish`.",
			);
		}
		sections.push(lines.join("\n"));
	}

	const images = surfaceMemberImagesSection(
		binding.memberImages ?? [],
		binding.viewAttachment ? "coding_view_attachment" : "company_read",
	);
	if (images) sections.push(images);

	return sections.join("\n\n");
}
