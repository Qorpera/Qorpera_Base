import {
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	type PointToChangeTarget,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
} from "@qorpera/contracts";
import {
	type SurfaceAttachmentReader,
	type SurfaceMemberImage,
	surfaceMemberImagesSection,
} from "./cloud-surface-images.ts";
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
	readonly sessionId?: string | null;
	readonly branch?: string | null;
	readonly parentSha?: string | null;
	readonly headSha?: string | null;
	readonly conflictPaths?: readonly string[] | null;
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
		out.push({
			changeId: typeof item.changeId === "string" ? item.changeId : null,
			title: typeof item.title === "string" ? item.title : null,
			sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
			branch: typeof item.branch === "string" ? item.branch : null,
			parentSha: typeof item.parentSha === "string" ? item.parentSha : null,
			headSha: typeof item.headSha === "string" ? item.headSha : null,
			conflictPaths,
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
				"Keep each staged change atomic, self-contained, and conflict-minimizing: stage one `stage_surface_patch` call per independent deliverable (for example, one change per report, article, blog post, or layout/section update) rather than bundling unrelated deliverables into a single change."
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
	if (openChanges.length > 0 && binding.repositoryKey) {
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

	const conflictPaths = binding.conflictPaths?.filter((p) => p.trim().length > 0) ?? [];
	const conflictDetails = binding.conflictDetails ?? [];
	if (conflictPaths.length > 0 || conflictDetails.length > 0) {
		const lines: string[] = ["## Conflict Reconciliation"];
		const mainSha = binding.mainSha?.trim();
		if (mainSha) {
			lines.push(`Target main SHA: \`${mainSha.slice(0, 64)}\``);
		}
		if (conflictDetails.length > 0) {
			lines.push("Conflicting staged changes to reconcile:");
			const maxDetails = 25;
			for (const detail of conflictDetails.slice(0, maxDetails)) {
				const label = detail.title?.trim() || detail.changeId?.trim() || "Staged change";
				const parts: string[] = [label.slice(0, 160)];
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
				lines.push(`- ${parts.join(" · ")}`);
			}
			if (conflictDetails.length > maxDetails) {
				lines.push(`- ...and ${conflictDetails.length - maxDetails} more conflicting changes`);
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
			"2. Inspect every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) across the conflicted files and preserve the intent of each change cleanly without dropping behavior.",
			"3. Run the repository's build and test checks (`coding_run_command` with `runChecks: true` when `.qorpera/checks.json` exists, plus targeted tests) to verify the reconciled code passes.",
			"4. Commit the clean resolution on the session branch, call `coding_record_change` with the resolved commit range, and finish with `coding_finish`.",
		);
		sections.push(lines.join("\n"));
	}

	const images = surfaceMemberImagesSection(
		binding.memberImages ?? [],
		binding.viewAttachment ? "coding_view_attachment" : "company_read",
	);
	if (images) sections.push(images);

	return sections.join("\n\n");
}
