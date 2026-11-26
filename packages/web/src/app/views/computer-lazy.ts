import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import type { ComputerOpen, ComputerPanel, ComputerPanelOptions, ComputerPanels } from "./computer.ts";
import { ComputerByItself } from "./computer-by-itself.ts";

export interface ComputerPanelsLike {
	readonly byItself: ComputerByItself;
	releaseAgent(agentId: string): Promise<boolean>;
	busy(): boolean;
	get(agentId: string): ComputerPanel | undefined;
	open(agent: HostedStaffAgent, open?: ComputerOpen): ComputerPanel | undefined;
	close(agentId: string): void;
	dispose(): void;
	ensureLoaded?(): Promise<void>;
	isLoaded?(): boolean;
}

type ComputerSource = WebCompanyComputer | ((Ctor: typeof WebCompanyComputer) => WebCompanyComputer) | undefined;

let preloadedComputerPanels: typeof ComputerPanels | undefined;
let preloadedWebCompanyComputer: typeof WebCompanyComputer | undefined;

export function registerLazyComputerModule(
	LoadedPanels: typeof ComputerPanels,
	LoadedComputer?: typeof WebCompanyComputer,
): void {
	preloadedComputerPanels = LoadedPanels;
	if (LoadedComputer) preloadedWebCompanyComputer = LoadedComputer;
}

export class LazyComputerPanels implements ComputerPanelsLike {
	readonly byItself = new ComputerByItself();
	readonly #computer: ComputerSource;
	readonly #signal: AbortSignal | undefined;
	readonly #options: ComputerPanelOptions;
	#inner: ComputerPanels | undefined;
	#loading: Promise<void> | undefined;
	#disposed = false;

	constructor(computer?: ComputerSource, signal?: AbortSignal, options: ComputerPanelOptions = {}) {
		this.#computer = computer;
		this.#signal = signal;
		this.#options = options;
		this.#initIfReady();
	}

	#initIfReady(): void {
		if (this.#inner || this.#disposed || this.#signal?.aborted || !preloadedComputerPanels) return;
		if (typeof this.#computer === "function") {
			if (!preloadedWebCompanyComputer) return;
			this.#inner = new preloadedComputerPanels(
				this.#computer(preloadedWebCompanyComputer),
				this.#signal,
				this.#options,
			);
			return;
		}
		this.#inner = new preloadedComputerPanels(this.#computer, this.#signal, this.#options);
	}

	isLoaded(): boolean {
		this.#initIfReady();
		return this.#inner !== undefined;
	}

	ensureLoaded(): Promise<void> {
		this.#initIfReady();
		if (this.#inner || this.#disposed || this.#signal?.aborted) return Promise.resolve();
		this.#loading ??= (async () => {
			try {
				const [{ ComputerPanels: LoadedPanels }, computerMod] = await Promise.all([
					preloadedComputerPanels
						? Promise.resolve({ ComputerPanels: preloadedComputerPanels })
						: import("./computer.ts"),
					typeof this.#computer === "function" && !preloadedWebCompanyComputer
						? import("../../cloud/computer.ts")
						: Promise.resolve(undefined),
				]);
				preloadedComputerPanels = LoadedPanels;
				if (computerMod) preloadedWebCompanyComputer = computerMod.WebCompanyComputer;
				this.#initIfReady();
			} finally {
				this.#loading = undefined;
			}
		})();
		return this.#loading;
	}

	releaseAgent(agentId: string): Promise<boolean> {
		return this.#inner ? this.#inner.releaseAgent(agentId) : Promise.resolve(true);
	}

	busy(): boolean {
		return this.#inner?.busy() ?? false;
	}

	get(agentId: string): ComputerPanel | undefined {
		return this.#inner?.get(agentId);
	}

	open(agent: HostedStaffAgent, open: ComputerOpen = {}): ComputerPanel | undefined {
		if (this.#disposed || this.#signal?.aborted) return undefined;
		this.#initIfReady();
		return this.#inner?.open(agent, open);
	}

	close(agentId: string): void {
		this.#inner?.close(agentId);
	}

	dispose(): void {
		this.#disposed = true;
		this.#inner?.dispose();
		this.#inner = undefined;
		this.byItself.dispose();
	}
}
