import { CloudMemberData } from "@qorpera/cloud-client/cloud-member-data";
import {
	CloudMemberFolderClient,
	CloudMemberFolderFileCache,
	CloudMemberFolderHints,
} from "@qorpera/cloud-client/cloud-member-folder";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { type CodeDownloadCalls, codeDownloadCalls } from "./code-downloads.ts";
import { memberRouteTarget } from "./deployment-config.ts";
import { forgetKeptObjects, KeptObjects } from "./kept-objects.ts";
import { createWebMessageErases, type WebMessageErases } from "./message-erases.ts";
import type { HostedProfile, HostedProfileRole } from "./types.ts";

/** A member's endpoints, token and transport for one company. */
interface MemberFolderOptions {
	readonly environmentId: string;
	readonly supabaseUrl: string;
	readonly publishableKey: string;
	readonly objectGatewayUrl: string;
	readonly accessToken: (signal: AbortSignal) => Promise<string>;
	readonly fetch: typeof fetch;
	readonly files: CloudMemberFolderFileCache;
	readonly kept: KeptObjects;
}

/** The bytes of files this tab's member has read, for every company they open: an app or a page opened again, and
 * the files it reads, are not fetched again (cloud-member-folder.ts `CloudMemberFolderFileCache`). Each read still asks
 * the folder for the file's entry as the member, so what they may read is decided live. Another member signed in here
 * starts from an empty one. */
let memberFiles:
	| { readonly memberId: string; readonly files: CloudMemberFolderFileCache; readonly kept: KeptObjects }
	| undefined;

function memberFileCache(memberId: string): { readonly files: CloudMemberFolderFileCache; readonly kept: KeptObjects } {
	if (memberFiles?.memberId !== memberId) {
		memberFiles?.files.clear();
		void memberFiles?.kept.close();
		memberFiles = { memberId, files: new CloudMemberFolderFileCache(), kept: new KeptObjects(memberId) };
	}
	return memberFiles;
}

/** Forgets every file read in this tab: at sign-out. */
export function forgetMemberFiles(): void {
	memberFiles?.files.clear();
	const kept = memberFiles?.kept;
	memberFiles = undefined;
	void (kept ? kept.forget() : forgetKeptObjects());
}

/** The product owns member lifetime; the shared SDK owns the company folder's calls. Every company is folder-v2
 * (founder decision, 3 October 2026): members read its folder (C4 P27) and write it through the member commit route
 * (P34a). */
export class WebCompanyFiles {
	readonly company: { readonly role: HostedProfileRole; readonly canWrite: boolean };
	readonly signal: AbortSignal;
	readonly #supabase: Cloud["supabase"];
	readonly #options: MemberFolderOptions;
	readonly #current: () => void;
	readonly #code: CodeDownloadCalls;
	readonly #dataGateway: string | undefined;
	readonly #hintListeners = new Set<{ onHint: (seq: number) => void; onState?: (connected: boolean) => void }>();
	#hintConnected = false;
	#hintChannel:
		| {
				joined: Promise<void>;
				stop: AbortController;
				hints?: CloudMemberFolderHints;
				closing?: Promise<void>;
				closed: boolean;
				onAbort: () => void;
		  }
		| undefined;
	constructor(
		cloud: Cloud,
		profile: HostedProfile,
		memberId: string,
		role: HostedProfileRole,
		signal: AbortSignal,
		current: () => void,
		canWrite = role !== "viewer",
	) {
		this.company = Object.freeze({ role, canWrite });
		this.signal = signal;
		this.#supabase = cloud.supabase;
		this.#current = current;
		this.#code = codeDownloadCalls(cloud, profile.profileId);
		this.#dataGateway = cloud.config.memberCompanyGatewayUrl;
		this.#options = {
			environmentId: profile.environmentId,
			supabaseUrl: cloud.config.projectUrl,
			publishableKey: cloud.config.publishableKey,
			objectGatewayUrl: cloud.config.objectGatewayUrl,
			accessToken: async (requestSignal) => {
				this.current();
				requestSignal.throwIfAborted();
				const { data, error } = await cloud.supabase.auth.getSession();
				this.current();
				requestSignal.throwIfAborted();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to open Company File.");
				return data.session.access_token;
			},
			files: memberFileCache(memberId).files,
			kept: memberFileCache(memberId).kept,
			fetch: async (input, init) => {
				this.current();
				// Enable the public bridge only after its deployment has been accepted.
				// This is a configured transport selection, never a fallback after a write.
				const target = memberRouteTarget(cloud.config, input instanceof Request ? input.url : String(input));
				const response = await fetch(input instanceof Request ? new Request(target, input) : target, {
					...init,
					credentials: "omit",
					signal: AbortSignal.any([
						signal,
						...(input instanceof Request ? [input.signal] : []),
						...(init?.signal ? [init.signal] : []),
					]),
				});
				try {
					this.current();
				} catch (error) {
					void response.body?.cancel().catch(() => undefined);
					throw error;
				}
				return response;
			},
		};
	}
	current(): void {
		this.signal.throwIfAborted();
		this.#current();
	}
	/** The company's folder: reads (C4 P27) and the member's change sets (P34a). */
	folder(): CloudMemberFolderClient {
		this.current();
		return new CloudMemberFolderClient({
			environmentId: this.#options.environmentId,
			supabaseUrl: this.#options.supabaseUrl,
			objectGatewayUrl: this.#options.objectGatewayUrl,
			publishableKey: this.#options.publishableKey,
			accessToken: this.#options.accessToken,
			fetch: this.#options.fetch,
			files: this.#options.files,
			kept: this.#options.kept,
		});
	}
	/** The company's databases, asked as the member through the member gateway (RUNTIME-COMPANY-DATABASES.md §3);
	 * undefined where the build names no member gateway. A question's file the gateway asks for is read with the
	 * member's own folder client, its bytes as they are (a leading byte order mark kept), so its hash is the entry's. */
	data(): CloudMemberData | undefined {
		this.current();
		const gatewayUrl = this.#dataGateway;
		if (!gatewayUrl) return undefined;
		const folder = this.folder();
		return new CloudMemberData({
			environmentId: this.#options.environmentId,
			gatewayUrl,
			accessToken: this.#options.accessToken,
			fetch: this.#options.fetch,
			readText: async (path, maximumBytes, signal) => {
				const entry = (await folder.read(path, signal)).entry;
				const file = entry?.kind === "file" ? entry.file : null;
				if (!file || file.bytes > maximumBytes) return null;
				try {
					const bytes = await folder.readFile(file, signal, maximumBytes, { cached: true });
					return {
						text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
						sha256: file.fileSha256,
					};
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof TypeError) return null;
					throw error;
				}
			},
		});
	}
	/** The company's code kept in Qorpera: its repositories, and a download of one (cloud/code-downloads.ts). */
	codeDownloads(): CodeDownloadCalls {
		this.current();
		return this.#code;
	}
	/** The member's erases of single messages (summary trees M3c), through the same member route transport. */
	messageErases(): WebMessageErases {
		this.current();
		return createWebMessageErases(this.#options);
	}
	/** The folder's hint (folder core C4, P30): `onHint(seq)` when it changed. Closes with this company's signal.
	 * Its private channel joins once Realtime holds the member's token. The client sets that only after its first
	 * answer, so a channel joined at once went out with the publishable key, was refused ("Unauthorized") and joined
	 * only on the 10 s retry (3 Nov 2026). `onState`: whether its channel is subscribed, each time that changes. */
	folderHints(onHint: (seq: number) => void, onState?: (connected: boolean) => void): { close(): Promise<void> } {
		this.current();
		const listener = { onHint, onState };
		this.#hintListeners.add(listener);
		if (!this.#hintChannel) {
			this.#openHintChannel();
		} else if (this.#hintConnected) {
			onState?.(true);
		}
		let closed = false;
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				this.#hintListeners.delete(listener);
				if (this.#hintListeners.size === 0) await this.#closeHintChannel();
			},
		};
	}

	#openHintChannel(): void {
		const stop = new AbortController();
		const state: NonNullable<typeof this.#hintChannel> = {
			joined: Promise.resolve(),
			stop,
			closed: false,
			onAbort: () => {
				void this.#closeHintChannel();
			},
		};
		this.#hintChannel = state;
		// WHY: Multiplex folder hints onto the authenticated cloud.supabase WebSocket instead of opening a duplicate Realtime client per subscriber.
		state.joined = withCloudDeadline(
			async (authSignal) => {
				const token = await this.#options.accessToken(authSignal);
				await this.#supabase.realtime?.setAuth(token);
			},
			5000,
			this.signal,
		)
			.catch(() => undefined)
			.then(() => {
				if (state.closed || this.signal.aborted || this.#hintChannel !== state) return;
				state.hints = new CloudMemberFolderHints({
					environmentId: this.#options.environmentId,
					client: this.#supabase,
					signal: stop.signal,
					onHint: (seq) => {
						for (const item of [...this.#hintListeners]) item.onHint(seq);
					},
					onState: (connected) => {
						this.#hintConnected = connected;
						for (const item of [...this.#hintListeners]) item.onState?.(connected);
					},
				});
			});
		if (this.signal.aborted) void this.#closeHintChannel();
		else this.signal.addEventListener("abort", state.onAbort, { once: true });
	}

	#closeHintChannel(): Promise<void> {
		const state = this.#hintChannel;
		if (!state) return Promise.resolve();
		this.#hintChannel = undefined;
		this.#hintConnected = false;
		state.closed = true;
		this.signal.removeEventListener("abort", state.onAbort);
		state.closing ??= (async () => {
			await state.joined;
			await state.hints?.close().catch(() => undefined);
			state.stop.abort();
		})();
		return state.closing;
	}
}
