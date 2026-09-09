import { showFilePanel } from "../../../../member-web/src/file-panel.ts";
import type { WebCompanyFiles } from "../../cloud/company-files.ts";
import { button, h, replace } from "../../ui/dom.ts";

/** Product presentation of the shared governed File interaction. */
export class LiveCompanyFileView {
	readonly el = h("section", { class: "page company-file live-company-file" });
	readonly routeHash: string;
	readonly role: string;
	readonly authorityKey: string;
	readonly #stop: AbortController;
	readonly #root = h("div");
	readonly #status = h("p", { role: "status" });
	#busy = false;
	#disposed = false;
	#close: (() => void) | undefined;
	#leave: () => string | null = () => null;
	constructor(
		company: WebCompanyFiles,
		stop: AbortController,
		profileId: string,
		authorityKey: string,
		reload?: () => void,
	) {
		this.#stop = stop;
		this.routeHash = location.hash;
		this.role = company.company.role;
		this.authorityKey = authorityKey;
		this.el.append(
			h("h1", null, "Company File"),
			h(
				"div",
				{ class: "row" },
				h("a", { href: `#/c/${profileId}/file/history` }, "Snapshots and proposals"),
				reload
					? button("Reload Company File", () => {
							if (stop.signal.aborted) return;
							if (
								this.leaveMessage() &&
								!window.confirm(
									"Reload Company File and discard local drafts? A submitted change may still apply. Open pending changes to check its result.",
								)
							)
								return;
							reload();
						})
					: null,
			),
			this.#status,
			this.#root,
		);
		const current = () => {
			company.current();
			stop.signal.throwIfAborted();
		};
		const work = async (action: () => Promise<void>) => {
			if (this.#busy || stop.signal.aborted) return;
			this.#busy = true;
			this.#root.inert = true;
			try {
				current();
				await action();
				current();
			} catch {
				if (!stop.signal.aborted)
					this.#status.textContent =
						"The operation could not be confirmed. Check the current state before retrying.";
			} finally {
				this.#busy = false;
				this.#root.inert = false;
			}
		};
		const initialize = async () => {
			this.#status.textContent = "Opening Company File…";
			try {
				const close = await showFilePanel({
					root: this.#root,
					company,
					work,
					current,
					status: (message) => {
						current();
						this.#status.textContent = message;
					},
					beforeLeave: (check) => {
						this.#leave = check;
					},
				});
				if (stop.signal.aborted) {
					close();
					return;
				}
				this.#close = close;
				this.#status.textContent = "";
			} catch (error) {
				if (!stop.signal.aborted)
					replace(
						this.#root,
						button("Retry opening Company File", () => void work(initialize)),
					);
				throw error;
			}
		};
		window.addEventListener(
			"beforeunload",
			(event) => {
				if (this.leaveMessage()) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			{ signal: stop.signal },
		);
		company.signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (company.signal.aborted) {
			this.dispose();
			return;
		}
		void work(initialize);
	}
	leaveMessage(): string | null {
		return this.#leave();
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stop.abort();
		this.#close?.();
		this.#close = undefined;
		this.#leave = () => null;
		this.el.replaceChildren();
		this.el.remove();
	}
}
