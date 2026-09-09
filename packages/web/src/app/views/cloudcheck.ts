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
	#disposed = false;
	readonly #abort = new AbortController();

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
		this.render();
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort.abort();
	}

	async run(): Promise<void> {
		if (this.#running || this.#disposed) return;
		this.#running = true;
		this.#results = [];
		this.render();
		await probeRpcs(
			this.#cloud,
			(result) => {
				if (this.#disposed) return;
				this.#results = [...this.#results, result];
				this.render();
			},
			this.#abort.signal,
		);
		this.#running = false;
		this.render();
	}

	render(): void {
		if (this.#disposed) return;
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
				`Target project: ${this.#cloud.config.projectUrl}. RPCs are checked with null arguments under your token. Present confirms a response; denied confirms a permission refusal; missing means the signature was not found. Unreachable means its presence could not be established. This check does not verify Realtime or object gateway access.`,
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
