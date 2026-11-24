import { createHash } from "node:crypto";
import { parseCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";
import type { SurfaceStarterKind } from "@qorpera/contracts";
import { PLATFORM_SKILL_FILES } from "./cloud-embedded-assets.ts";

export { PLATFORM_SKILL_FILES };

export interface CloudPlatformSkill {
	readonly name: string;
	readonly description: string | null;
	readonly body: string;
	readonly version: string;
}

function textVersion(text: string): string {
	const hex = createHash("sha256").update(`qorpera.platform-skill/v1\n${text}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const CLOUD_PLATFORM_SKILLS: ReadonlyMap<string, CloudPlatformSkill> = new Map(
	Object.keys(PLATFORM_SKILL_FILES)
		.sort()
		.map((name) => {
			const text = PLATFORM_SKILL_FILES[name] as string;
			const document = parseCloudSkillFile(text);
			return [name, { name, description: document.description, body: document.body, version: textVersion(text) }];
		}),
);

export const SURFACE_STARTER_SKILLS: Readonly<Record<SurfaceStarterKind, string>> = {
	product: "product-studio",
	identity: "identity-studio",
	custom: "custom-surface",
};

export const MAX_STUDIO_SKILL_BYTES = 8 * 1024;
