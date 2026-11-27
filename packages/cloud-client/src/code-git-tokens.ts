import {
	type CodeGitTokenScope,
	type CodeGitTokenSummary,
	type CreatedCodeGitToken,
	isUuid,
	parseCodeGitTokenSummary,
	parseCreatedCodeGitToken,
	parseRevokedCodeGitToken,
	type RevokedCodeGitToken,
} from "@qorpera/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CreateCodeGitTokenInput {
	readonly environmentId: string;
	readonly label: string;
	readonly scope?: CodeGitTokenScope;
	readonly owner?: string | null;
	readonly name?: string | null;
	readonly expiresDays?: number;
}

export async function createCodeGitToken(
	supabase: SupabaseClient,
	input: CreateCodeGitTokenInput,
): Promise<CreatedCodeGitToken> {
	if (!isUuid(input.environmentId)) {
		throw new Error("environmentId must be a valid UUID");
	}
	const { data, error } = await supabase.rpc("qorpera_create_code_git_token", {
		p_environment_id: input.environmentId,
		p_label: input.label,
		p_scope: input.scope ?? "read",
		p_owner: input.owner ?? null,
		p_name: input.name ?? null,
		p_expires_days: input.expiresDays ?? 30,
	});
	if (error) {
		throw new Error(error.message || "Failed to create Git token");
	}
	return parseCreatedCodeGitToken(data);
}

export async function listCodeGitTokens(
	supabase: SupabaseClient,
	environmentId: string,
): Promise<readonly CodeGitTokenSummary[]> {
	if (!isUuid(environmentId)) {
		throw new Error("environmentId must be a valid UUID");
	}
	const { data, error } = await supabase.rpc("qorpera_list_code_git_tokens", {
		p_environment_id: environmentId,
	});
	if (error) {
		throw new Error(error.message || "Failed to list Git tokens");
	}
	if (!Array.isArray(data)) {
		return [];
	}
	return data.map((row) => parseCodeGitTokenSummary(row));
}

export async function revokeCodeGitToken(
	supabase: SupabaseClient,
	tokenId: string,
): Promise<RevokedCodeGitToken> {
	if (!isUuid(tokenId)) {
		throw new Error("tokenId must be a valid UUID");
	}
	const { data, error } = await supabase.rpc("qorpera_revoke_code_git_token", {
		p_token_id: tokenId,
	});
	if (error) {
		throw new Error(error.message || "Failed to revoke Git token");
	}
	return parseRevokedCodeGitToken(data);
}
