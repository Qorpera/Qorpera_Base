import type { Cloud } from "../../cloud/client.ts";
import { probeRpcs, RPC_PROBES, type RpcProbeResult } from "../../cloud/probe.ts";
import { badge, button, h, notice, replace, spinner } from "../../ui/dom.ts";

/* Cloud check: verifies, with the signed-in member's token, that every RPC
 * the app relies on exists on the target project (CLIENT-CONTRACT.md,
 * "Verify before relying on any entry"). */

export class CloudCheckView {
	readonly el = h("section", { class: "page cloud-check" });
	readonly #cloud: Cloud;
	#results: RpcProbeResult[] = [];
	#running = false;

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
		this.render();
	}

	async run(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#results = [];
		this.render();
		await probeRpcs(this.#cloud, (result) => {
			this.#results = [...this.#results, result];
			this.render();
		});
		this.#running = false;
		this.render();
	}

	render(): void {
		const missing = this.#results.filter((result) => result.state === "missing");
		const report = this.#results
			.map((result) => `${result.state.padEnd(10)} ${result.name} (${result.area}) — ${result.detail}`)
			.join("\n");
		replace(
			this.el,
			h("h1", null, "Cloud check"),
			h(
				"p",
				{ class: "muted" },
				`Target project: ${this.#cloud.config.projectUrl}. Each RPC is called with null arguments under your token; "missing" means PostgREST cannot find it (PGRST202), "present" means it exists and answered or refused as expected.`,
			),
			h(
				"div",
				{ class: "row" },
				button(this.#running ? "Checking…" : "Run check", () => void this.run(), {
					primary: true,
					disabled: this.#running,
				}),
				this.#results.length ? button("Copy report", () => void navigator.clipboard?.writeText(report)) : null,
			),
			missing.length
				? notice(
						"warn",
						`${missing.length} of ${RPC_PROBES.length} functions are not deployed: ${missing.map((result) => result.name).join(", ")}. Features that need them are shown as not available.`,
					)
				: null,
			this.#running ? spinner(`Probing ${this.#results.length}/${RPC_PROBES.length}`) : null,
			this.#results.length
				? h(
						"table",
						{ class: "table" },
						h(
							"thead",
							null,
							h(
								"tr",
								null,
								h("th", null, "State"),
								h("th", null, "RPC"),
								h("th", null, "Area"),
								h("th", null, "Detail"),
							),
						),
						h(
							"tbody",
							null,
							...this.#results.map((result) =>
								h(
									"tr",
									null,
									h(
										"td",
										null,
										badge(
											result.state,
											result.state === "present" ? "ok" : result.state === "missing" ? "warn" : "neutral",
										),
									),
									h("td", null, h("code", null, result.name)),
									h("td", null, result.area),
									h("td", { class: "muted small" }, result.detail),
								),
							),
						),
					)
				: null,
		);
	}
}
