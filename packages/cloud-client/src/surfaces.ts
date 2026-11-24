import {
	type CrossSurfaceHandoffRequest,
	type PointToChangeTarget,
	parsePointToChangeTarget,
	parseSurfaceAutomationSummary,
	parseSurfaceMigrationChecklist,
	parseSurfacePreviewCompositionState,
	parseSurfaceReconciliation,
	parseSurfaceSession,
	parseSurfaceSessionImages,
	parseSurfaceSummary,
	parseSurfaceUnseenNotes,
	parseSurfaceWorkspace,
	type SurfaceArchetype,
	type SurfaceAutomationSummary,
	type SurfaceChangeUnit,
	type SurfaceImageRef,
	type SurfaceKind,
	type SurfaceMigrationChecklist,
	type SurfacePreviewCompositionState,
	type SurfaceReconciliation,
	type SurfaceSession,
	type SurfaceSessionImages,
	type SurfaceSessionMessage,
	type SurfaceSummary,
	type SurfaceUnseenNote,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface StartSurfaceSessionOptions {
	readonly title?: string;
	readonly target?: PointToChangeTarget;
	readonly explorationCount?: 2 | 3;
	readonly explorationTitle?: string;
	readonly variantLabels?: readonly string[];
	readonly originKind?: "member" | "cofounder" | "automation" | "point_to_change" | "cross_surface";
	readonly originLabel?: string;
	readonly clientInputId?: string;
	readonly images?: readonly SurfaceImageRef[];
	readonly previewBaseChangeIds?: readonly string[];
}

export interface CreateSurfaceRpcInput {
	readonly title: string;
	readonly slug?: string;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind;
	readonly icon?: string;
	readonly accentHex?: string | null;
	readonly folderRoot?: string | null;
	readonly briefSummary?: string | null;
	readonly isGlobal?: boolean;
}

export interface CreateSurfaceAutomationInput {
	readonly title: string;
	readonly prompt: string;
	readonly scheduleSummary?: string;
	readonly targetSurfaceSlug?: string | null;
}

export interface UpdateSurfaceAutomationInput {
	readonly title?: string;
	readonly prompt?: string;
	readonly scheduleSummary?: string;
	readonly targetSurfaceSlug?: string | null;
}

export interface SetSurfacePreviewSelectionInput {
	readonly toggledChangeIds: readonly string[];
	readonly explorationSessionId?: string | null;
	readonly compareSessionIds?: readonly string[];
	readonly activeRoute?: string;
}

export interface ApplySurfaceMigrationInput {
	readonly activateSurfaceSlugs: readonly string[];
	readonly agentDecisions: readonly {
		readonly agentId: string;
		readonly action: "fold_to_automation" | "fold_to_surface_brief" | "archive_readonly" | "keep";
		readonly targetSurfaceSlug?: string | null;
	}[];
	readonly archiveBoardNames: readonly string[];
}

export class CloudSurfacesError extends Error {
	readonly code: string | null;
	constructor(message: string, code: string | null = null) {
		super(message);
		this.name = "CloudSurfacesError";
		this.code = code;
	}
}

// WHY: Lets packages/web degrade gracefully to synthesized local surfaces when talking to an unmigrated database.
export function isMissingSurfaceRpcError(error: unknown): boolean {
	if (error instanceof CloudSurfacesError) return error.code === "PGRST202" || error.code === "42883";
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return code === "PGRST202" || code === "42883";
	}
	return false;
}

export function isSurfacesDisabledError(error: unknown): boolean {
	if (error instanceof CloudSurfacesError) return error.code === "0A000";
	if (error && typeof error === "object" && "code" in error) {
		return (error as { code?: unknown }).code === "0A000";
	}
	return false;
}

export interface SurfacePreviewPassGrant {
	readonly previewId: string;
	readonly doorActionUrl: string;
	readonly memberPass: string;
}

function surfaceImageRows(
	images: readonly SurfaceImageRef[],
): { objectSha256: string; bytes: number; mediaType: string }[] {
	return images.map((image) => ({ objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType }));
}

function automationOf(data: unknown, name: string): SurfaceAutomationSummary {
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new CloudSurfacesError(`Invalid ${name} payload`);
	return parseSurfaceAutomationSummary((data as Record<string, unknown>).automation, "automation");
}

export class CloudSurfacesClient {
	readonly #supabase: SupabaseClient;

	constructor(supabase: SupabaseClient) {
		this.#supabase = supabase;
	}

	async #rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
		const { data, error } = await this.#supabase.rpc(name, args);
		if (error) {
			throw new CloudSurfacesError(error.message || `${name} failed`, error.code ?? null);
		}
		return data;
	}

	async isSurfacesEnabled(): Promise<boolean> {
		const data = await this.#rpc("qorpera_surfaces_enabled", {});
		return data === true;
	}

	async mintPreviewPass(previewId: string): Promise<SurfacePreviewPassGrant> {
		const data = await this.#rpc("qorpera_mint_surface_preview_pass", { p_preview_id: previewId });
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new CloudSurfacesError("Invalid qorpera_mint_surface_preview_pass payload");
		}
		const record = data as Record<string, unknown>;
		if (
			typeof record.previewId !== "string" ||
			typeof record.doorActionUrl !== "string" ||
			typeof record.memberPass !== "string" ||
			!record.previewId ||
			!record.doorActionUrl ||
			!record.memberPass
		) {
			throw new CloudSurfacesError("Invalid qorpera_mint_surface_preview_pass fields");
		}
		return {
			previewId: record.previewId,
			doorActionUrl: record.doorActionUrl,
			memberPass: record.memberPass,
		};
	}

	async listSurfaces(companyId: string): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_list_surfaces", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_list_surfaces payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}

	async createSurface(companyId: string, input: CreateSurfaceRpcInput): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_create_surface", {
			p_company_id: companyId,
			p_title: input.title,
			p_slug: input.slug ?? null,
			p_archetype: input.archetype,
			p_kind: input.kind ?? "custom",
			p_icon: input.icon ?? "globe",
			p_accent_hex: input.accentHex ?? null,
			p_folder_root: input.folderRoot ?? null,
			p_brief_summary: input.briefSummary ?? null,
			p_is_global: input.isGlobal ?? input.kind === "identity",
		});
		return parseSurfaceSummary(data, "surface");
	}

	async bootstrapCompanySurfaces(companyId: string): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_bootstrap_company_surfaces", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_bootstrap_company_surfaces payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}

	async getSurfaceWorkspace(surfaceId: string): Promise<SurfaceWorkspace> {
		const data = await this.#rpc("qorpera_get_surface_workspace", { p_surface_id: surfaceId });
		return parseSurfaceWorkspace(data, "workspace");
	}

	async approveProposedSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_approve_proposed_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async archiveSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_archive_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async setSurfaceAutoPublish(surfaceId: string, enabled: boolean): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_set_surface_auto_publish", {
			p_surface_id: surfaceId,
			p_auto_publish: enabled,
		});
		return parseSurfaceSummary(data, "surface");
	}

	async setSurfaceFigure(surfaceId: string, figure: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_set_surface_figure", { p_surface_id: surfaceId, p_figure: figure });
		return parseSurfaceSummary(data, "surface");
	}

	async startSurfaceSession(
		surfaceId: string,
		prompt: string,
		options: StartSurfaceSessionOptions = {},
	): Promise<SurfaceSession> {
		const target = options.target ? parsePointToChangeTarget(options.target) : null;
		const images = options.images ?? [];
		if (images.length > 0 && !options.clientInputId)
			throw new CloudSurfacesError("Surface session images need a client input id");
		const previewBaseChangeIds = [
			...new Set((options.previewBaseChangeIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
		].slice(0, 64);
		const originRef =
			previewBaseChangeIds.length > 0
				? target
					? { ...target, previewBaseChangeIds }
					: { previewBaseChangeIds }
				: target;
		const args = {
			p_surface_id: surfaceId,
			p_prompt: prompt,
			p_title: options.title ?? null,
			p_origin_kind: options.originKind ?? (target ? "point_to_change" : "member"),
			p_origin_label: options.originLabel ?? null,
			p_origin_ref: originRef,
			p_exploration_count: options.explorationCount ?? null,
			p_exploration_title: options.explorationTitle ?? null,
			...(options.variantLabels ? { p_variant_labels: [...options.variantLabels] } : {}),
		};
		const data =
			images.length > 0
				? await this.#rpc("qorpera_start_surface_session_with_images", {
						...args,
						p_client_input_id: options.clientInputId,
						p_images: surfaceImageRows(images),
					})
				: await this.#rpc("qorpera_start_surface_session", args);
		return parseSurfaceSession(data, "session");
	}

	async replySurfaceSession(
		sessionId: string,
		message: string,
		keepOpen = true,
		attach?: { clientInputId: string; images: readonly SurfaceImageRef[] },
	): Promise<SurfaceSession> {
		const args = { p_session_id: sessionId, p_message: message, p_keep_open: keepOpen };
		const data =
			attach && attach.images.length > 0
				? await this.#rpc("qorpera_reply_surface_session_with_images", {
						...args,
						p_client_input_id: attach.clientInputId,
						p_images: surfaceImageRows(attach.images),
					})
				: await this.#rpc("qorpera_reply_surface_session", args);
		return parseSurfaceSession(data, "session");
	}

	async noteSurfaceSession(sessionId: string, message: string, to: readonly string[]): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_surface_session_note", {
			p_session_id: sessionId,
			p_message: message,
			p_to: [...to],
		});
		return parseSurfaceSession(data, "session");
	}

	async unseenSurfaceNotes(companyId: string): Promise<SurfaceUnseenNote[]> {
		const data = await this.#rpc("qorpera_surface_unseen_notes", { p_profile_id: companyId });
		return parseSurfaceUnseenNotes(data);
	}

	async markSurfaceNotesSeen(sessionId: string): Promise<void> {
		await this.#rpc("qorpera_surface_notes_seen", { p_session_id: sessionId });
	}

	async surfaceSessionImages(sessionId: string): Promise<SurfaceSessionImages> {
		const data = await this.#rpc("qorpera_surface_session_images", { p_session_id: sessionId });
		return parseSurfaceSessionImages(data);
	}

	async setSessionChatOpen(sessionId: string, open: boolean): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_set_session_chat_open", {
			p_session_id: sessionId,
			p_open: open,
		});
		return parseSurfaceSession(data, "session");
	}

	async approveSurfaceChange(changeId: string, includeDependencies = true): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_approve_surface_change", {
			p_change_id: changeId,
			p_include_dependencies: includeDependencies,
		});
		return parseSurfaceSession(data, "session");
	}

	async approveSessionAll(sessionId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_approve_session_all", { p_session_id: sessionId });
		return parseSurfaceSession(data, "session");
	}

	async discardSurfaceChange(changeId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_discard_surface_change", { p_change_id: changeId });
		return parseSurfaceSession(data, "session");
	}

	async discardSurfaceSession(sessionId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_discard_surface_session", { p_session_id: sessionId });
		return parseSurfaceSession(data, "session");
	}

	async undoSurfaceChange(changeId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_undo_surface_change", { p_change_id: changeId });
		return parseSurfaceSession(data, "session");
	}

	async chooseExploration(explorationId: string, sessionId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_choose_exploration", {
			p_exploration_id: explorationId,
			p_session_id: sessionId,
		});
		return parseSurfaceSession(data, "session");
	}

	async discardExploration(explorationId: string): Promise<void> {
		await this.#rpc("qorpera_discard_exploration", { p_exploration_id: explorationId });
	}

	async reconcileChanges(surfaceId: string, changeIds: readonly string[]): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_reconcile_surface_changes", {
			p_surface_id: surfaceId,
			p_change_ids: [...changeIds],
		});
		return parseSurfaceSession(data, "session");
	}

	async ensureSurfaceReconciliation(
		surfaceId: string,
		changeIds: readonly string[],
		conflictPaths: readonly string[] = [],
		retry = false,
	): Promise<SurfaceReconciliation> {
		const data = await this.#rpc("qorpera_ensure_surface_reconciliation", {
			p_surface_id: surfaceId,
			p_change_ids: [...changeIds],
			p_conflict_paths: [...conflictPaths],
			p_retry: retry,
		});
		return parseSurfaceReconciliation(data, "reconciliation");
	}

	async spawnCrossSurfaceSession(request: CrossSurfaceHandoffRequest): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_spawn_cross_surface_session", {
			p_source_surface_id: request.sourceSurfaceId,
			p_target_surface_slug: request.targetSurfaceSlug,
			p_prompt: request.prompt,
			p_title: request.title ?? null,
			p_source_ref: request.sourceRef ?? null,
		});
		return parseSurfaceSession(data, "session");
	}

	async setPreviewSelection(
		surfaceId: string,
		selection: SetSurfacePreviewSelectionInput,
	): Promise<SurfacePreviewCompositionState> {
		const data = await this.#rpc("qorpera_set_preview_selection", {
			p_surface_id: surfaceId,
			p_toggled_change_ids: [...selection.toggledChangeIds],
			p_exploration_session_id: selection.explorationSessionId ?? null,
			p_compare_session_ids: selection.compareSessionIds ? [...selection.compareSessionIds] : [],
			p_active_route: selection.activeRoute ?? "/",
		});
		return parseSurfacePreviewCompositionState(data, "previewState");
	}

	async publishSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_publish_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async askSurfacePublish(surfaceId: string, userId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_ask_surface_publish", { p_surface_id: surfaceId, p_user_id: userId });
		return parseSurfaceSummary(data, "surface");
	}

	async declineSurfacePublishAsk(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_decline_surface_publish_ask", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async withdrawSurfacePublishAsk(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_withdraw_surface_publish_ask", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async listAutomations(companyId: string): Promise<SurfaceAutomationSummary[]> {
		const data = await this.#rpc("qorpera_list_automations", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_list_automations payload");
		return data.map((item, index) => parseSurfaceAutomationSummary(item, `automations[${index}]`));
	}

	async toggleAutomation(automationId: string, enabled: boolean): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_toggle_automation", {
			p_automation_id: automationId,
			p_enabled: enabled,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async createAutomation(companyId: string, input: CreateSurfaceAutomationInput): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_create_surface_automation", {
			p_company_id: companyId,
			p_title: input.title,
			p_prompt: input.prompt,
			p_schedule_summary: input.scheduleSummary ?? "Every day · 09:00",
			p_target_surface_slug: input.targetSurfaceSlug ?? null,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async updateAutomation(
		automationId: string,
		input: UpdateSurfaceAutomationInput,
	): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_update_surface_automation", {
			p_automation_id: automationId,
			p_title: input.title ?? null,
			p_prompt: input.prompt ?? null,
			p_schedule_summary: input.scheduleSummary ?? null,
			p_target_surface_slug: input.targetSurfaceSlug ?? null,
			p_clear_target: input.targetSurfaceSlug === null,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async offerAutomation(automationId: string, toUserId: string): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_offer_surface_automation", {
			p_automation_id: automationId,
			p_to_user_id: toUserId,
		});
		return automationOf(data, "qorpera_offer_surface_automation");
	}

	async answerAutomationOffer(offerId: string, yes: boolean): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_answer_surface_automation_offer", { p_offer_id: offerId, p_yes: yes });
		return automationOf(data, "qorpera_answer_surface_automation_offer");
	}

	async deleteAutomation(automationId: string): Promise<boolean> {
		const data = await this.#rpc("qorpera_delete_surface_automation", { p_automation_id: automationId });
		return data === true;
	}

	async getMigrationChecklist(companyId: string): Promise<SurfaceMigrationChecklist> {
		const data = await this.#rpc("qorpera_surface_migration_checklist", { p_company_id: companyId });
		return parseSurfaceMigrationChecklist(data, "migrationChecklist");
	}

	async applyMigrationChecklist(companyId: string, input: ApplySurfaceMigrationInput): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_apply_surface_migration", {
			p_company_id: companyId,
			p_activate_surface_slugs: [...input.activateSurfaceSlugs],
			p_agent_decisions: input.agentDecisions,
			p_archive_board_names: [...input.archiveBoardNames],
		});
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_apply_surface_migration payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}
}

export type {
	PointToChangeTarget,
	SurfaceAutomationSummary,
	SurfaceChangeUnit,
	SurfaceMigrationChecklist,
	SurfacePreviewCompositionState,
	SurfaceReconciliation,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
};
