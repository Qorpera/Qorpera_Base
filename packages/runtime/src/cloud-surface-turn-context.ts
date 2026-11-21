import type { PointToChangeTarget } from "@qorpera/contracts";
import type { CloudSurfaceToolsPort } from "./cloud-surface-tools.ts";

export interface SurfaceIdentityContext {
	readonly briefMarkdown?: string | null;
	readonly tokensJson?: string | null;
	readonly voiceSummary?: string | null;
}

export interface SurfaceCodingTurnBinding {
	readonly sessionId: string;
	readonly surfaceSlug: string;
	readonly surfaceTitle: string;
	readonly briefMarkdown: string | null;
	readonly identityContext?: SurfaceIdentityContext | null;
	readonly pointToChangeTarget?: PointToChangeTarget | null;
	readonly conflictPaths?: readonly string[] | null;
	readonly recordChange: CloudSurfaceToolsPort["recordChange"];
}

export const SURFACE_STAGED_CODING_INSTRUCTIONS =
	"This session is scoped to a Qorpera Surface — a direct live projection of its codebase or Company Files folder. " +
	"Founders preview multiple unmerged staged changes from concurrent sessions toggled on or off simultaneously in Preview before approving or landing any of them onto main. " +
	"Keep each staged change atomic, self-contained, and conflict-minimizing: touch only the files needed for this deliverable and avoid unrequested sweeping refactors across shared files. " +
	"For each cohesive user-visible deliverable you complete, commit cleanly on the current branch and call coding_record_change with a plain founder-facing title, short summary, and commit SHA before moving to the next change. " +
	"When all requested deliverables are committed and verified, call coding_finish to stage the session as ready for review.";

// WHY: Injects global company Identity assets, Surface domain taste (brief.md), Point-to-Change DOM context, and conflict paths directly into scoped coding turns.
export function buildSurfaceTurnBrief(binding: SurfaceCodingTurnBinding): string {
	const sections: string[] = [
		`# Surface Context: ${binding.surfaceTitle} (${binding.surfaceSlug})`,
		`Session ID: ${binding.sessionId}`,
		"## Surface Projection & Parallel Preview\n" +
			"This Surface projects its underlying codebase or Company Files folder directly into the live Preview. " +
			"Founders can toggle multiple unmerged staged changes from concurrent sessions on and off together in Preview before approving or publishing them. " +
			"Keep each staged change atomic, self-contained, and conflict-minimizing — touch only the files required for your deliverable and avoid unnecessary edits to unrelated shared files.",
	];

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
		sections.push(
			`## Conflict Reconciliation\nReconcile overlapping changes cleanly across these files:\n${binding.conflictPaths.map((path) => `- ${path}`).join("\n")}`,
		);
	}

	return sections.join("\n\n");
}
