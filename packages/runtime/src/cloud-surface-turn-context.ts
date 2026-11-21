import type { PointToChangeTarget } from "@qorpera/contracts";
import type { CloudSurfaceToolsPort } from "./cloud-surface-tools.ts";

export interface SurfaceCodingTurnBinding {
	readonly sessionId: string;
	readonly surfaceSlug: string;
	readonly surfaceTitle: string;
	readonly briefMarkdown: string | null;
	readonly pointToChangeTarget?: PointToChangeTarget | null;
	readonly conflictPaths?: readonly string[] | null;
	readonly recordChange: CloudSurfaceToolsPort["recordChange"];
}

export const SURFACE_STAGED_CODING_INSTRUCTIONS =
	"This session is scoped to a Qorpera Surface. Your commits are staged for founder preview and selective approval rather than auto-landed on main. " +
	"For each cohesive user-visible deliverable you complete, commit cleanly on the current branch and call coding_record_change with a plain founder-facing title, short summary, and commit SHA before moving to the next change. " +
	"When all requested deliverables are committed and verified, call coding_finish to stage the session as ready for review.";

// WHY: Injects Surface domain taste (brief.md), Point-to-Change DOM context, and conflict paths directly into scoped coding turns.
export function buildSurfaceTurnBrief(binding: SurfaceCodingTurnBinding): string {
	const sections: string[] = [
		`# Surface Context: ${binding.surfaceTitle} (${binding.surfaceSlug})`,
		`Session ID: ${binding.sessionId}`,
	];

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
