import type { HostedStaffAgent } from "../../cloud/types.ts";
import { colorFor, figureFor, nativeColorOf } from "../../ui/avatar.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { Store } from "../state.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";

/** Editable values in the latest roster projection. */
export function savedAgentDraft(agent: HostedStaffAgent): AgentDraft {
	const figure = figureFor(agent);
	return {
		displayName: agent.displayName,
		role: agent.role,
		charter: agent.charter,
		figure,
		color: agent.templateId === "co-founder" ? nativeColorOf(figure) : colorFor(agent, figure),
	};
}

interface AgentEditState {
	draft: Partial<AgentDraft>;
	status: string;
	failed: boolean;
}

const edits = new WeakMap<CompanyController, Map<string, AgentEdits>>();

/** A single writer per agent survives opening and closing its details panel.
 * Failed drafts are offered for explicit retry, never replayed on reopening.
 * Navigation and company disposal end the writer's scope. */
export class AgentEdits {
	readonly store = new Store<AgentEditState>({ draft: {}, status: "", failed: false });
	readonly #company: CompanyController;
	readonly #agent: HostedStaffAgent;
	readonly #update: WorkspaceActions["updateAgent"];
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#attempt = new AbortController();
	#revision = 0;
	#written = 0;
	#saving = false;
	readonly #changes = new Map<keyof AgentDraft, number>();
	readonly #accepted = new Map<keyof AgentDraft, { change: number; version: number }>();
	constructor(company: CompanyController, agent: HostedStaffAgent, actions: WorkspaceActions, scope: AbortSignal) {
		this.#company = company;
		this.#agent = agent;
		this.#update = actions.updateAgent;
		this.#unsubscribe = company.store.subscribe(() => {
			if (!company.store.get().team?.capabilities.read || !company.staffById(agent.id)) this.dispose();
			else if (!this.canWrite()) {
				// Losing authority cancels queued writes as well as the active request.
				this.#attempt.abort();
				this.#attempt = new AbortController();
				this.#written = this.#revision;
				this.#changes.clear();
				this.#accepted.clear();
				this.store.set({ draft: {}, status: "", failed: false });
			} else this.#reconcile();
		});
		for (const signal of [company.signal, scope]) {
			if (signal.aborted) this.dispose();
			else signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		}
	}
	get signal(): AbortSignal {
		return this.#lifetime.signal;
	}
	canWrite(): boolean {
		return (
			!this.signal.aborted &&
			this.#company.store.get().team?.capabilities.authorize === true &&
			Boolean(this.#update)
		);
	}
	current(): AgentDraft {
		return { ...savedAgentDraft(this.#company.staffById(this.#agent.id) ?? this.#agent), ...this.store.get().draft };
	}
	change(change: Partial<AgentDraft>): void {
		if (!this.canWrite()) return;
		this.#reconcile();
		this.#revision++;
		for (const key of Object.keys(change) as (keyof AgentDraft)[]) this.#changes.set(key, this.#revision);
		this.store.set(({ draft }) => ({ draft: { ...draft, ...change } }));
		void this.save();
	}
	/** A later roster revision supersedes an accepted overlay even when polling
	 * skipped the revision we wrote. Newer pending/failed edits keep their own generation. */
	#reconcile(): void {
		const agent = this.#company.staffById(this.#agent.id);
		if (!agent) return;
		const draft = { ...this.store.get().draft };
		let changed = false;
		for (const [key, accepted] of this.#accepted) {
			if (agent.version < accepted.version) continue;
			this.#accepted.delete(key);
			if (this.#changes.get(key) !== accepted.change) continue;
			this.#changes.delete(key);
			delete draft[key];
			changed = true;
		}
		if (changed) this.store.set({ draft });
	}
	async save(): Promise<void> {
		if (this.#saving || !this.#update || !this.canWrite() || this.#written === this.#revision) return;
		this.#saving = true;
		const signal = AbortSignal.any([this.signal, this.#attempt.signal]);
		this.store.set({ status: t("Saving…"), failed: false });
		try {
			do {
				while (this.#written < this.#revision) {
					signal.throwIfAborted();
					if (!this.canWrite()) throw new Error(t("Only an owner or admin can change agents."));
					const revision = this.#revision;
					const changes = new Map(this.#changes);
					const version = await this.#update(
						this.#company.staffById(this.#agent.id) ?? this.#agent,
						this.current(),
						signal,
					);
					signal.throwIfAborted();
					for (const [key, change] of changes) this.#accepted.set(key, { change, version });
					this.#written = revision;
					this.#reconcile();
				}
				await this.#company.refreshStaff();
				signal.throwIfAborted();
			} while (this.#written < this.#revision);
			this.#reconcile();
			this.store.set({ status: t("Saved"), failed: false });
		} catch {
			if (!signal.aborted) this.store.set({ status: t("Your changes could not be saved."), failed: true });
		} finally {
			this.#saving = false;
			// A newly authorized edit may arrive while an aborted request settles.
			// Revocation already discarded the old queue; only that new edit may run.
			if (signal.aborted) void this.save();
		}
	}
	dispose(): void {
		if (this.signal.aborted) return;
		this.#lifetime.abort();
		this.#unsubscribe();
		this.store.set({ draft: {}, status: "", failed: false });
		this.store.dispose();
		if (edits.get(this.#company)?.get(this.#agent.id) === this) edits.get(this.#company)?.delete(this.#agent.id);
	}
}

export function editsFor(
	company: CompanyController,
	agent: HostedStaffAgent,
	actions: WorkspaceActions,
	scope: AbortSignal,
): AgentEdits {
	let agents = edits.get(company);
	if (!agents) {
		agents = new Map();
		edits.set(company, agents);
	}
	let current = agents.get(agent.id);
	if (!current || current.signal.aborted) {
		current = new AgentEdits(company, agent, actions, scope);
		agents.set(agent.id, current);
	}
	return current;
}
