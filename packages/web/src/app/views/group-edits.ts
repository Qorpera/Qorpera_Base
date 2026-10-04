import { describeError } from "../../cloud/client.ts";
import type { GroupChatDetails, GroupChatDraft } from "../../cloud/group-details.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { Store } from "../state.ts";
import { GroupUpdateNotWrittenError } from "../update-group.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";

interface GroupEditState {
	status: string;
	failed: boolean;
}

interface GroupEditAttempt {
	observed: GroupChatDetails;
	draft: GroupChatDraft;
	changes: Map<keyof GroupChatDraft, number>;
}

const edits = new WeakMap<CompanyController, Map<string, GroupEdits>>();

/** One sequential room writer survives closing its details dialog. An uncertain
 * request retains its exact revision and values for the updater's safe retry. */
export class GroupEdits {
	readonly store = new Store<GroupEditState>({ status: "", failed: false });
	readonly #company: CompanyController;
	readonly #update: WorkspaceActions["updateGroup"];
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	readonly #changes = new Map<keyof GroupChatDraft, number>();
	#details: GroupChatDetails;
	#draft: Partial<GroupChatDraft> = {};
	#revision = 0;
	#attempt = new AbortController();
	#retry: GroupEditAttempt | undefined;
	#saving = false;
	#needsRefresh = false;
	#resetting = false;
	#resetRequired = false;

	constructor(company: CompanyController, details: GroupChatDetails, actions: WorkspaceActions, scope: AbortSignal) {
		this.#company = company;
		this.#details = details;
		this.#update = actions.updateGroup;
		this.#unsubscribe = company.store.subscribe(() => {
			if (!this.#available()) this.dispose();
			else {
				const latest = company.store.get().groups?.[details.roomId];
				if (latest) this.reconcile(latest);
				if (!this.#authorized()) this.#discard();
			}
		});
		for (const signal of [company.signal, scope]) {
			if (signal.aborted) this.dispose();
			else signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		}
	}

	get signal(): AbortSignal {
		return this.#lifetime.signal;
	}

	#available(): boolean {
		const state = this.#company.store.get();
		const session = state.sessions.find((item) => item.sessionId === this.#details.sessionId);
		return (
			!this.signal.aborted &&
			!this.#company.signal.aborted &&
			!state.accessLost &&
			state.team?.capabilities.read === true &&
			state.team.profileId === this.#company.profile.profileId &&
			Boolean(session && !session.staffAgentId) &&
			session?.executionScope?.roomId === this.#details.roomId &&
			session?.profileId === this.#company.profile.profileId &&
			session?.environmentId === this.#details.environmentId &&
			this.#details.environmentId === this.#company.profile.environmentId
		);
	}

	canWrite(): boolean {
		return !this.#resetting && !this.#resetRequired && this.#authorized();
	}

	canRecover(): boolean {
		return !this.#saving && !this.#resetting && this.#authorized();
	}

	#authorized(): boolean {
		const team = this.#company.store.get().team;
		return (
			this.#available() &&
			this.#details.status === "active" &&
			this.#company.store
				.get()
				.sessions.some((item) => item.sessionId === this.#details.sessionId && item.status === "open") &&
			Boolean(this.#update) &&
			Boolean(team?.capabilities.authorize && team.capabilities.write && ["owner", "admin"].includes(team.role))
		);
	}

	current(): GroupChatDraft {
		const { name, purpose, members, subtitle } = this.#details;
		const draft = { name, purpose, members, ...(subtitle !== undefined ? { subtitle } : {}), ...this.#draft };
		return { ...draft, members: draft.members.map((member) => ({ ...member })) };
	}

	change(change: Partial<GroupChatDraft>): void {
		if (!this.canWrite()) return;
		this.#revision++;
		for (const key of Object.keys(change) as (keyof GroupChatDraft)[]) this.#changes.set(key, this.#revision);
		this.#draft = { ...this.#draft, ...change };
		if (change.members) this.#draft.members = change.members.map((member) => ({ ...member }));
		// Reopening and typing after a failure must not silently replay an uncertain write.
		if (!this.store.get().failed) void this.save();
		else this.store.set({});
	}

	reconcile(details: GroupChatDetails): void {
		if (
			this.signal.aborted ||
			details.roomId !== this.#details.roomId ||
			details.sessionId !== this.#details.sessionId ||
			details.environmentId !== this.#details.environmentId ||
			details.version < this.#details.version
		)
			return;
		this.#details = details;
		if (!this.#authorized()) this.#discard();
	}

	#discard(): void {
		this.#attempt.abort();
		this.#attempt = new AbortController();
		this.#retry = undefined;
		this.#draft = {};
		this.#changes.clear();
		this.#needsRefresh = false;
		this.#resetRequired = false;
		this.store.set({ status: "", failed: false });
	}

	/** Explicitly abandon a rejected/uncertain request and read the canonical
	 * revision before allowing a fresh draft. Never race an active save. */
	async discardChanges(): Promise<void> {
		if (this.#saving || this.#resetting || !this.#authorized()) return;
		this.#discard();
		this.#resetting = true;
		this.#resetRequired = true;
		const signal = AbortSignal.any([this.signal, this.#attempt.signal]);
		this.store.set({ status: t("Refreshing group details…"), failed: false });
		try {
			await this.#company.refreshSessions();
			signal.throwIfAborted();
			const details = await this.#company.groupDetails(this.#details.sessionId, signal);
			signal.throwIfAborted();
			if (details.version < this.#details.version) throw new Error(t("Group details are not current yet."));
			this.reconcile(details);
			signal.throwIfAborted();
			this.#resetRequired = false;
			this.store.set({ status: "", failed: false });
		} catch {
			if (!signal.aborted) this.store.set({ status: t("Group details could not be refreshed."), failed: true });
		} finally {
			this.#resetting = false;
			this.store.set({});
		}
	}

	async save(): Promise<void> {
		if (this.#resetRequired) return this.discardChanges();
		if (this.#saving || !this.#update || !this.canWrite() || (!this.#changes.size && !this.#needsRefresh)) return;
		this.#saving = true;
		const signal = AbortSignal.any([this.signal, this.#attempt.signal]);
		this.store.set({ status: t("Saving…"), failed: false });
		try {
			do {
				while (this.#changes.size) {
					signal.throwIfAborted();
					if (!this.canWrite()) throw new Error(t("Only an owner or admin can change group chats."));
					const retrying = this.#retry !== undefined;
					const attempt = this.#retry ?? {
						observed: { ...this.#details, members: this.#details.members.map((member) => ({ ...member })) },
						draft: this.current(),
						changes: new Map(this.#changes),
					};
					this.#retry = attempt;
					let wrote: boolean;
					try {
						wrote = await this.#update(attempt.observed.sessionId, attempt.observed, attempt.draft, signal);
					} catch (error) {
						// A failed preflight can accept corrections, but cannot resolve an earlier uncertain write.
						if (error instanceof GroupUpdateNotWrittenError && !retrying) this.#retry = undefined;
						throw error;
					}
					signal.throwIfAborted();
					this.#retry = undefined;
					this.#needsRefresh = true;
					for (const [key, revision] of attempt.changes) {
						if (this.#changes.get(key) !== revision) continue;
						this.#changes.delete(key);
						delete this.#draft[key];
					}
					// A write raises the room's version by one. A retry that finds its write already in the file writes
					// nothing, but the uncertain try it repeats (or another writer) raised it. Nothing written leaves it.
					this.reconcile({
						...attempt.observed,
						...attempt.draft,
						name: attempt.draft.name.trim(),
						purpose: attempt.draft.purpose.trim(),
						...(attempt.draft.subtitle !== undefined ? { subtitle: attempt.draft.subtitle.trim() } : {}),
						version: attempt.observed.version + (wrote || retrying ? 1 : 0),
					});
				}
				await this.#company.refreshSessions();
				signal.throwIfAborted();
				this.reconcile(await this.#company.groupDetails(this.#details.sessionId, signal));
				signal.throwIfAborted();
				this.#needsRefresh = false;
			} while (this.#changes.size);
			this.store.set({ status: t("Saved"), failed: false });
		} catch (error) {
			if (!signal.aborted) this.store.set({ status: describeError(error), failed: true });
		} finally {
			this.#saving = false;
			if (signal.aborted) void this.save();
		}
	}

	dispose(): void {
		if (this.signal.aborted) return;
		this.#lifetime.abort();
		this.#unsubscribe();
		this.#discard();
		this.store.dispose();
		if (edits.get(this.#company)?.get(this.#details.roomId) === this)
			edits.get(this.#company)?.delete(this.#details.roomId);
	}
}

export function groupEditsFor(
	company: CompanyController,
	details: GroupChatDetails,
	actions: WorkspaceActions,
	scope: AbortSignal,
): GroupEdits {
	let groups = edits.get(company);
	if (!groups) {
		groups = new Map();
		edits.set(company, groups);
	}
	let current = groups.get(details.roomId);
	if (!current || current.signal.aborted) {
		current = new GroupEdits(company, details, actions, scope);
		groups.set(details.roomId, current);
	} else current.reconcile(details);
	return current;
}
