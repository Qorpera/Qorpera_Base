import { CloudRpcError, describeError } from "../../cloud/client.ts";
import { COMPANY_MEMORY_MODES, type CompanyMemory, type CompanyMemoryMode } from "../../cloud/memory-mode.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

/** What the Memory section needs of the cloud: the company's memory, and an owner's or admin's choice. */
export interface WebCompanyMemory {
	read(): Promise<CompanyMemory>;
	choose(mode: CompanyMemoryMode): Promise<CompanyMemory>;
}

const modeName = (mode: CompanyMemoryMode) => (mode === "tree" ? t("Shared context — Beta") : t("Agent notebooks"));

let groups = 0;

/**
 * Settings → Company → Memory (scope reset 17 Oct, C5): Agent notebooks, the default, or the
 * Shared context beta, shown unavailable while the company is not offered it. Every member sees
 * the choice; owners and admins make it. A choice applies to runs that start after it, so the
 * section says how many runs still finish in the other memory. Switching deletes and rewrites
 * nothing. On a cloud without the choice every run uses notebooks, and the section stays hidden.
 */
export class MemoryView {
	readonly el = h("section", { class: "settings-group settings-memory", "aria-label": t("Memory"), hidden: true });
	readonly #client: WebCompanyMemory;
	readonly #lifetime = new AbortController();
	readonly #name = `settings-memory-${++groups}`;
	readonly #inputs = new Map<CompanyMemoryMode, HTMLInputElement>(
		COMPANY_MEMORY_MODES.map((mode) => [mode, this.#radio(mode)]),
	);
	readonly #retry = button(t("Retry"), () => void this.#refresh(), { small: true });
	#memory: CompanyMemory | undefined;
	#loading = true;
	#missing = false;
	#loadError: string | undefined;
	#changeError: string | undefined;
	/** The choice being saved: its radio stays checked until the cloud answers. */
	#pending: CompanyMemoryMode | undefined;
	#working = false;
	#saved = false;

	readonly #role: () => string | undefined;
	#readRole: string | undefined;
	/** Counts loads and changes: a load that a newer load or a change overtook is dropped. */
	#generation = 0;
	#refreshing = false;
	/** A change dropped a load on its way, or was refused: load again once the change is done. */
	#stale = false;
	/** The latest load succeeded. */
	#read = false;

	/** `role` is the member's current role in the company: a change reloads (who may choose changes). */
	constructor(client: WebCompanyMemory, signal: AbortSignal, role: () => string | undefined = () => undefined) {
		this.#client = client;
		this.#role = role;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	/** The company changed: reload when the member's role did (after any change on its way). */
	update(): void {
		if (this.#loading || this.#working) return;
		const role = this.#role();
		// The role arriving after a read that went without it changes nothing: the read already
		// carries the cloud's answer on who may choose. A failed read is still retried when it arrives.
		if (!this.#stale && this.#readRole === undefined && role !== undefined && this.#read) {
			this.#readRole = role;
			return;
		}
		if (this.#stale || role !== this.#readRole) void this.#refresh();
	}

	#radio(mode: CompanyMemoryMode): HTMLInputElement {
		const id = `${this.#name}-${mode}`;
		const input = h("input", {
			type: "radio",
			name: this.#name,
			value: mode,
			"aria-labelledby": `${id}-name`,
			"aria-describedby": `${id}-about`,
		});
		input.onchange = () => {
			if (input.checked) void this.#choose(mode);
		};
		return input;
	}

	async #refresh(): Promise<void> {
		const generation = ++this.#generation;
		// The role is noted as the load starts: a failed load is not retried until the role moves.
		this.#readRole = this.#role();
		this.#stale = false;
		this.#refreshing = true;
		const current = () => !this.#lifetime.signal.aborted && generation === this.#generation;
		try {
			const memory = await this.#client.read();
			if (!current()) return;
			this.#memory = memory;
			this.#missing = false;
			this.#loadError = undefined;
			this.#read = true;
		} catch (error) {
			if (!current()) return;
			this.#read = false;
			this.#missing = error instanceof CloudRpcError && error.missing;
			this.#loadError = this.#missing ? undefined : describeError(error);
		} finally {
			if (current()) {
				this.#refreshing = false;
				this.#loading = false;
				this.#draw();
				// A role that moved while the first load was on its way loads again.
				this.update();
			}
		}
	}

	async #choose(mode: CompanyMemoryMode): Promise<void> {
		if (!this.#memory || this.#working || this.#loading || mode === this.#memory.mode) {
			this.#draw();
			return;
		}
		// Disabled while saving, the radio would drop the keyboard: it goes back to the choice after.
		const refocus = this.el.contains(document.activeElement);
		// A load already on its way may not have this change: drop it, and load again once the change is done.
		if (this.#refreshing) this.#stale = true;
		this.#refreshing = false;
		this.#generation++;
		this.#working = true;
		this.#pending = mode;
		this.#changeError = undefined;
		this.#saved = false;
		this.#draw();
		try {
			this.#memory = await this.#client.choose(mode);
			this.#saved = true;
		} catch (error) {
			if (!this.#lifetime.signal.aborted) {
				this.#changeError =
					error instanceof CloudRpcError && error.code === "55000"
						? t("Shared context — Beta is not available for this company yet.")
						: describeError(error);
				// The refusal may come from what changed since the read (the beta, the member's role).
				this.#stale = true;
			}
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#pending = undefined;
				this.#working = false;
				this.#draw();
				if (refocus) this.#focusChoice();
				this.update();
			}
		}
	}

	#focusChoice(): void {
		const checked = [...this.#inputs.values()].find((input) => input.checked && !input.disabled);
		checked?.focus({ preventScroll: true });
	}

	#choice(memory: CompanyMemory, mode: CompanyMemoryMode): HTMLElement {
		const input = this.#inputs.get(mode)!;
		const unavailable = mode === "tree" && !memory.betaOffered;
		input.checked = (this.#pending ?? memory.mode) === mode;
		input.disabled = this.#working || !memory.canManage || unavailable;
		const id = `${this.#name}-${mode}`;
		return h(
			"label",
			{ class: unavailable ? "settings-preference-row is-unavailable" : "settings-preference-row" },
			h(
				"span",
				{ class: "settings-copy" },
				h("strong", { id: `${id}-name` }, modeName(mode)),
				h(
					"small",
					{ id: `${id}-about` },
					mode === "tree"
						? t("Agents share one summary of the company's conversations and work.")
						: t("Each agent keeps its own notebook of what it learns."),
					unavailable ? [" ", t("Not available for this company yet.")] : null,
				),
			),
			input,
		);
	}

	/** Runs that started in the other memory than new runs get: each finishes in its own. */
	#transition(memory: CompanyMemory): HTMLElement | null {
		if (memory.runsInOtherMode <= 0) return null;
		const mode = modeName(memory.effective === "tree" ? "notebooks" : "tree");
		return notice(
			"neutral",
			memory.runsInOtherMode === 1
				? t("One run that started before the change still uses {mode} until it finishes.", { mode })
				: t("{count} runs that started before the change still use {mode} until they finish.", {
						count: memory.runsInOtherMode,
						mode,
					}),
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const memory = this.#memory;
		// Nothing to show before the first answer, or on a cloud without the choice.
		this.el.hidden = this.#missing || (!memory && !this.#loadError);
		if (this.el.hidden) {
			replace(this.el);
			return;
		}
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		replace(
			this.el,
			h("h2", null, t("Memory")),
			this.#loadError ? [notice("danger", this.#loadError), this.#retry] : null,
			memory ? this.#choices(memory) : null,
		);
		if (focused instanceof HTMLElement && this.el.contains(focused) && !(focused as HTMLInputElement).disabled) {
			focused.focus({ preventScroll: true });
		} else if (focused) this.#focusChoice();
	}

	/** The two choices, then what the member should know about them. */
	#choices(memory: CompanyMemory): (HTMLElement | null)[] {
		// Chosen while the beta was offered, then withdrawn: the choice stays, new runs use notebooks.
		const withdrawn = memory.mode === "tree" && memory.effective === "notebooks";
		const rows = COMPANY_MEMORY_MODES.map((mode) => this.#choice(memory, mode));
		return [
			h("fieldset", { class: "settings-rows settings-memory-choices", "aria-label": t("Memory") }, ...rows),
			this.#changeError ? notice("danger", this.#changeError) : null,
			withdrawn
				? notice("warn", t("Shared context — Beta is not available now, so new runs use Agent notebooks."))
				: null,
			this.#transition(memory),
			this.#saved ? notice("ok", t("Saved. New runs use {mode}.", { mode: modeName(memory.effective) })) : null,
			memory.canManage
				? null
				: h("p", { class: "settings-rule-note" }, t("Owners and admins choose the company's memory.")),
			h(
				"p",
				{ class: "settings-rule-note" },
				t(
					"A change applies to new runs. A run already started keeps its memory until it ends. Nothing is deleted or rewritten.",
				),
			),
		];
	}
}
