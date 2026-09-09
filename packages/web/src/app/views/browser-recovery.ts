import { showRecoveryPanel } from "../../../../member-web/src/recovery-panel.ts";
import { webBrowserRecovery } from "../../cloud/browser-recovery.ts";
import type { Cloud } from "../../cloud/client.ts";
import { button, h, replace } from "../../ui/dom.ts";

export class BrowserRecoveryView {
	readonly el = h("section", { class: "page browser-recovery" });
	readonly #stop = new AbortController();
	readonly #root = h("div");
	readonly #status = h("p", { role: "status" });
	#close: (() => void) | undefined;
	#busy = false;
	constructor(cloud: Cloud, memberId: string, current: () => void) {
		this.el.append(
			h("h1", null, "Browser access"),
			h("a", { href: "#/account" }, "Back to account"),
			this.#status,
			this.#root,
		);
		const context = webBrowserRecovery(cloud, memberId, this.#stop.signal, current);
		const work = async (action: () => Promise<void>) => {
			if (this.#busy || this.#stop.signal.aborted) return;
			this.#busy = true;
			this.#root.inert = true;
			try {
				context.current();
				await action();
				context.current();
			} catch {
				if (!this.#stop.signal.aborted)
					this.#status.textContent =
						"The operation could not be confirmed. Refresh the current state before retrying.";
			} finally {
				this.#busy = false;
				this.#root.inert = false;
			}
		};
		const initialize = async () => {
			this.#status.textContent = "Checking your browser access…";
			try {
				const close = await showRecoveryPanel({
					root: this.#root,
					account: { recovery: () => context },
					work,
					current: context.current,
					status: (message) => {
						context.current();
						this.#status.textContent = message;
					},
				});
				if (this.#stop.signal.aborted) {
					close();
					return;
				}
				this.#close = close;
				this.#status.textContent = "";
			} catch (error) {
				if (!this.#stop.signal.aborted)
					replace(
						this.#root,
						button("Retry browser access", () => void work(initialize)),
					);
				throw error;
			}
		};
		void work(initialize);
	}
	dispose(): void {
		this.#stop.abort();
		this.#close?.();
		this.#close = undefined;
		this.el.replaceChildren();
		this.el.remove();
	}
}
