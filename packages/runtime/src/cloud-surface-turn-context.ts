import {
	IDENTITY_BRIEF_PATH,
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	IDENTITY_VOICE_PATH,
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
	'Commit source only, never build output: the platform builds Preview and every publish itself from the preview recipe in .qorpera/checks.json — "preview": { "run": the install and build command such as "npm ci && npm run build", "folder": the folder the build writes such as "dist", "cwd": where to run it (default "."), "timeoutSeconds": up to 600 } — beside a package.json in that cwd and the file\'s "checks" list. Give every project that needs a build a real preview recipe, and keep the built site within 500 files, 100 folders and 25 MB. Without one (or with run "true") Preview serves committed static files from site.folder, index.html at the repository root, dist/build/out/public, or apps/<repo>*/index.html. ' +
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

	const sections: string[] = [
		headerLines.join("\n"),
		"## Surface Projection & Parallel Preview\n" +
			"This Surface projects its underlying codebase or Company Files folder directly into the live Preview. A project with a `preview` recipe in `.qorpera/checks.json` (`run`, `folder`, `cwd`, `timeoutSeconds`, beside a `package.json`) is built by the platform for Preview and for every publish, so commit source only, never build output; without one, Preview serves committed static files (`site.folder`, root `index.html`, `dist`/`build`/`out`/`public`, or `apps/<repo>*/index.html`). " +
			"Founders can toggle multiple unmerged staged changes from concurrent sessions on and off together in Preview before approving or publishing them. " +
			'For multi-file codebases, verify changes pre-flight with `coding_run_command` (`runChecks: true` when `.qorpera/checks.json` exists; opt into `"surfaceGate": "stage"` to enforce checks automatically on `coding_finish`, or leave default `"none"` for instant Preview staging). ' +
			"Keep each staged change atomic, self-contained, and conflict-minimizing — touch only the files required for your deliverable and avoid unnecessary edits to unrelated shared files.",
	];

	if (explorationVariantLabel) {
		sections.push(
			`## Exploration Direction: ${explorationVariantLabel}\nDeliver a distinct, cohesive take matching this direction so founders can compare side-by-side variants cleanly in Preview.`,
		);
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
				`- **Identity Studio Projection:** Studio renders \`${IDENTITY_TOKENS_JSON_PATH}\` (Palette, Typography, Design System), \`${IDENTITY_LOGO_PATH}\` (Brand mark), \`${IDENTITY_VOICE_PATH}\` and \`${IDENTITY_BRIEF_PATH}\` (Voice & guidelines as Markdown prose), and \`identity/*.report.json\` (Philosophy) natively — do not hand-edit \`${IDENTITY_TOKENS_CSS_PATH}\` or create standalone HTML/CSS showcase pages like \`identity/index.html\`.`,
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
