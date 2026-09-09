import type {
	CloudCompanyComputerAccess,
	CompanyComputerAccessCapabilities,
} from "@qorpera/cloud-client/cloud-company-computer-access";
import { button, h, replace } from "../../ui/dom.ts";

export class ComputerAccessPanel {
	readonly el = h("section", { class: "stack", "aria-label": "Agent computer permissions" });
	readonly #stop = new AbortController();
	#busy = false;
	constructor(client: CloudCompanyComputerAccess, agentName: string, parentSignal: AbortSignal) {
		const signal = AbortSignal.any([parentSignal, this.#stop.signal]);
		const status = h("p", { role: "status" }),
			controls = h("div", { class: "stack" });
		this.el.append(
			h("h2", null, "Computer permissions"),
			h("p", { class: "muted" }, `Choose what ${agentName} can do. Permissions remain until revoked.`),
			status,
			controls,
		);
		const run = async (work: () => Promise<void>) => {
			if (this.#busy || signal.aborted) return;
			this.#busy = true;
			controls.inert = true;
			try {
				await work();
			} catch {
				if (!signal.aborted) {
					status.textContent = "Permissions could not be confirmed. Refresh before making another change.";
					replace(
						controls,
						button("Refresh permissions", () => void run(refresh)),
					);
				}
			} finally {
				this.#busy = false;
				controls.inert = false;
			}
		};
		const refresh = async () => {
			replace(controls);
			status.textContent = "Checking permissions…";
			const observed = await client.status(signal);
			signal.throwIfAborted();
			const active = observed.grant?.state === "active";
			status.textContent = active ? "This agent has computer access." : "This agent has no computer access.";
			const desktop = h("input", {
				type: "checkbox",
				checked: active && observed.grant?.capabilities.some((value) => value === "desktop"),
				"aria-label": "Allow desktop interaction",
			});
			const shell = h("input", {
				type: "checkbox",
				checked: active && observed.grant?.capabilities.some((value) => value === "shell"),
				"aria-label": "Allow shell commands",
			});
			const save = button(
				"Save computer permissions",
				() =>
					void run(async () => {
						const capabilities: CompanyComputerAccessCapabilities = desktop.checked
							? shell.checked
								? ["desktop", "shell"]
								: ["desktop"]
							: ["shell"];
						if (!desktop.checked && !shell.checked) return;
						await client.configure(
							{ expectedVersion: observed.grant?.version ?? 0, enabled: true, capabilities },
							signal,
						);
						signal.throwIfAborted();
						await refresh();
					}),
			);
			const update = () => {
				save.disabled = !desktop.checked && !shell.checked;
			};
			desktop.onchange = shell.onchange = update;
			update();
			controls.append(
				h("label", { class: "row" }, desktop, "Allow desktop interaction"),
				h("label", { class: "row" }, shell, "Allow shell commands"),
				save,
				button(
					"Revoke computer access",
					() =>
						void run(async () => {
							if (!observed.grant || observed.grant.state !== "active") return;
							await client.configure(
								{
									expectedVersion: observed.grant.version,
									enabled: false,
									capabilities: observed.grant.capabilities,
								},
								signal,
							);
							signal.throwIfAborted();
							await refresh();
						}),
					{ disabled: !active },
				),
				button("Refresh permissions", () => void run(refresh)),
			);
		};
		void run(refresh);
	}
	dispose(): void {
		this.#stop.abort();
		this.el.remove();
		this.el.replaceChildren();
	}
}
