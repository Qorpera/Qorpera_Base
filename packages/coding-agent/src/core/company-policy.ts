/**
 * Company policy is behavioral guidance for agents, not an authorization
 * boundary. The technical authority kernel remains separate and authoritative.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { Authority } from "./authority.ts";
import { verifyAuthorityPolicy } from "./founder-identity.ts";

export const COMPANY_POLICY_KEYS = [
	"spending",
	"external_communication",
	"hard_to_reverse_changes",
	"information_sharing",
] as const;

export type CompanyPolicyKey = (typeof COMPANY_POLICY_KEYS)[number];
export type CompanyPolicyMode = "ask" | "act" | "auto";
export type CompanyPolicyConfig = Record<CompanyPolicyKey, CompanyPolicyMode>;

export const DEFAULT_COMPANY_POLICY: CompanyPolicyConfig = {
	spending: "ask",
	external_communication: "ask",
	hard_to_reverse_changes: "ask",
	information_sharing: "ask",
};

const POLICY_SCOPES: Record<CompanyPolicyKey, string> = {
	spending: "Spending, purchases, subscriptions, or other financial commitments",
	external_communication: "External communication sent or published as the company",
	hard_to_reverse_changes: "Destructive or otherwise hard-to-reverse changes",
	information_sharing: "Company or user information shared outside the company",
};

const POLICY_BEHAVIOR: Record<CompanyPolicyMode, string> = {
	ask: "Ask the user before taking this action.",
	act: "Take this action when the user directly requests or clearly authorizes it; otherwise ask.",
	auto: "Take this action without asking when it reasonably advances the user's request.",
};

export function isCompanyPolicyMode(value: unknown): value is CompanyPolicyMode {
	return value === "ask" || value === "act" || value === "auto";
}

export function parseCompanyPolicy(source: string): CompanyPolicyConfig {
	const parsed = parseToml(source) as Record<string, unknown>;
	const section = parsed.policy;
	const policy: CompanyPolicyConfig = { ...DEFAULT_COMPANY_POLICY };
	if (!section || typeof section !== "object" || Array.isArray(section)) return policy;
	for (const key of COMPANY_POLICY_KEYS) {
		const value = (section as Record<string, unknown>)[key];
		if (isCompanyPolicyMode(value)) policy[key] = value;
	}
	return policy;
}

export function readCompanyPolicy(authority: Authority): CompanyPolicyConfig {
	if (!existsSync(authority.configPath)) return { ...DEFAULT_COMPANY_POLICY };
	const provenance = verifyAuthorityPolicy(authority.root);
	if (provenance !== "no-identity" && provenance !== "valid") return { ...DEFAULT_COMPANY_POLICY };
	try {
		return parseCompanyPolicy(readFileSync(authority.configPath, "utf-8"));
	} catch {
		return { ...DEFAULT_COMPANY_POLICY };
	}
}

export function formatCompanyPolicyInstructions(policy: CompanyPolicyConfig): string {
	return [
		"Company policy instructions",
		"These are behavioral instructions, not technical permissions. They never expand access or bypass safeguards.",
		...COMPANY_POLICY_KEYS.map((key) => `- ${POLICY_SCOPES[key]}: ${POLICY_BEHAVIOR[policy[key]]}`),
	].join("\n");
}

/**
 * Update only known keys inside [policy]. Existing comments, unrelated keys,
 * and every other TOML section remain byte-for-byte unchanged.
 */
export function updateCompanyPolicySource(source: string, policy: CompanyPolicyConfig): string {
	// Refuse to repair malformed authority files implicitly. The raw editor can
	// be used when the existing document itself needs attention.
	parseToml(source);

	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(/\r?\n/);
	const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
	const policyHeaderPattern = /^\s*\[policy\]\s*(?:#.*)?$/;
	const start = lines.findIndex((line) => policyHeaderPattern.test(line));

	if (start === -1) {
		const block = ["[policy]", ...COMPANY_POLICY_KEYS.map((key) => `${key} = "${policy[key]}"`)].join(newline);
		if (source.length === 0) return `${block}${newline}`;
		const separator = source.endsWith(`${newline}${newline}`)
			? ""
			: source.endsWith(newline)
				? newline
				: `${newline}${newline}`;
		return `${source}${separator}${block}${newline}`;
	}

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (tablePattern.test(lines[index])) {
			end = index;
			break;
		}
	}

	const missing: CompanyPolicyKey[] = [];
	for (const key of COMPANY_POLICY_KEYS) {
		const assignmentPattern = new RegExp(`^(\\s*)${key}\\s*=`);
		const index = lines.findIndex(
			(line, candidate) => candidate > start && candidate < end && assignmentPattern.test(line),
		);
		if (index === -1) {
			missing.push(key);
			continue;
		}
		const indentation = lines[index].match(assignmentPattern)?.[1] ?? "";
		const comment = lines[index].match(/\s+#.*$/)?.[0] ?? "";
		lines[index] = `${indentation}${key} = "${policy[key]}"${comment}`;
	}

	let insertion = end;
	while (insertion > start + 1 && lines[insertion - 1].trim() === "") insertion -= 1;
	lines.splice(insertion, 0, ...missing.map((key) => `${key} = "${policy[key]}"`));
	return lines.join(newline);
}
