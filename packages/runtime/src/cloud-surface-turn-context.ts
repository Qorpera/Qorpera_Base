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
	readonly recordChange?: CloudSurfaceToolsPort["recordChange"];
}

export interface SurfaceCodingTurnBinding extends SurfaceTurnBriefInput {
	readonly recordChange: CloudSurfaceToolsPort["recordChange"];
}

export const SURFACE_STAGED_CODING_INSTRUCTIONS =
	"IMPORTANT — Surface Staged Mode (overrides direct-landing instructions above): " +
	"This session is scoped to a Qorpera Surface — a direct live projection of its codebase or Company Files folder. " +
	"Commits you make on this session branch stay STAGED for founder Preview and approval and do NOT land on main until the founder approves them. " +
	"Founders preview multiple unmerged staged changes from concurrent sessions toggled on or off simultaneously in Preview before approving or publishing any of them. " +
	"Preview renders static web assets from the repository's index.html at the root or from the folder configured in .qorpera/checks.json under site.folder — make sure a clean servable index.html and its assets are committed on the session branch (commit the built output folder if you use a bundler). " +
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
			"This Surface projects its underlying codebase or Company Files folder directly into the live Preview. " +
			"Founders can toggle multiple unmerged staged changes from concurrent sessions on and off together in Preview before approving or publishing them. " +
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

	if (binding.conflictPaths && binding.conflictPaths.length > 0) {
		const maxConflictPaths = 100;
		const shown = binding.conflictPaths.slice(0, maxConflictPaths).map((path) => `- ${path.slice(0, 256)}`);
		const overflow = binding.conflictPaths.length - shown.length;
		if (overflow > 0) {
			shown.push(`- ...and ${overflow} more paths`);
		}
		sections.push(
			`## Conflict Reconciliation\nReconcile overlapping changes cleanly across these files:\n${shown.join("\n")}`,
		);
	}

	return sections.join("\n\n");
}
