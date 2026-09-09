import type { CloudMemberBrowserRecovery, MemberBrowserRecoveryCatalog } from "./cloud-member-browser-recovery.ts";
import { MemberCompanyBrowserSession } from "./member-company-browser-session.ts";

function exact(value: Record<string, unknown>, keys: string) {
	if (Object.keys(value).sort().join() !== keys) throw new Error("Invalid browser cleanup request");
}
/** Cleanup-only account surface: no creation, consent enablement, viewer or
 * new private entry. Each target must come from the account's own catalog. */
export class MemberBrowserRecoverySession {
	readonly #client: CloudMemberBrowserRecovery;
	readonly #current: () => void;
	readonly #signal: AbortSignal;
	#catalog?: MemberBrowserRecoveryCatalog;
	#selected?: MemberBrowserRecoveryCatalog["offices"][number];
	#browser?: MemberCompanyBrowserSession;
	#busy = false;
	constructor(options: { client: CloudMemberBrowserRecovery; current(): void; signal: AbortSignal }) {
		this.#client = options.client;
		this.#current = options.current;
		this.#signal = options.signal;
	}
	async action(value: unknown): Promise<unknown> {
		this.#current();
		this.#signal.throwIfAborted();
		if (
			this.#busy ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			JSON.stringify(value).length > 4096
		)
			throw new Error("Invalid browser cleanup request");
		this.#busy = true;
		try {
			const input = value as Record<string, unknown>;
			let result: unknown;
			if (input.method === "offices") {
				exact(input, "after,method");
				if (input.after !== null && (typeof input.after !== "string" || input.after !== this.#catalog?.nextAfter))
					throw new Error("Refresh browser cleanup");
				this.#catalog = undefined;
				this.#selected = undefined;
				this.#browser = undefined;
				const catalog = await this.#client.catalog(this.#signal, input.after as string | null);
				this.#current();
				this.#catalog = catalog;
				result = catalog;
			} else if (input.method === "selectOffice") {
				exact(input, "companyComputerId,method");
				this.#selected = undefined;
				this.#browser = undefined;
				const office = this.#catalog?.offices.find(
					(office) => office.scope.companyComputerId === input.companyComputerId,
				);
				if (!office) throw new Error("Refresh browser cleanup");
				this.#selected = office;
				this.#browser = new MemberCompanyBrowserSession({
					profiles: this.#client.profiles(office.scope),
					signIn: this.#client.signIn(office.scope),
					current: this.#current,
					signal: this.#signal,
				});
				result = structuredClone(office);
			} else {
				if (
					!this.#selected ||
					!this.#browser ||
					!["profiles", "privacy", "browserGrant", "configureBrowser", "finishPrivate"].includes(
						input.method as string,
					) ||
					(input.method === "configureBrowser" && input.enabled !== false)
				)
					throw new Error("Browser cleanup only");
				if (input.method === "privacy" && !this.#selected.ownsPrivacy) {
					exact(input, "method");
					result = null;
				} else result = await this.#browser.action(value, { staffIds: [], viewingAvailable: false });
			}
			this.#current();
			this.#signal.throwIfAborted();
			return result;
		} finally {
			this.#busy = false;
		}
	}
}
