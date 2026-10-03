import {
	CloudMemberCompanyFileClient,
	type CloudMemberCompanyMode,
	parseCloudMemberCompanyMode,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { CloudMemberCompanyFileReader } from "@qorpera/cloud-client/cloud-member-company-file";
import { CloudMemberCompanyPresence } from "@qorpera/cloud-client/cloud-member-company-presence";
import { CloudMemberFolderClient, CloudMemberFolderHints } from "@qorpera/cloud-client/cloud-member-folder";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import { createClient } from "@supabase/supabase-js";
import type { Cloud } from "./client.ts";
import type { HostedProfile, HostedProfileRole } from "./types.ts";

/** The product owns member lifetime; the shared SDK owns governed File calls. */
export class WebCompanyFiles {
	readonly company: { readonly role: HostedProfileRole; readonly canWrite: boolean };
	readonly signal: AbortSignal;
	readonly #options: ConstructorParameters<typeof CloudMemberCompanyFileClient>[0];
	readonly #current: () => void;
	#mode?: Promise<CloudMemberCompanyMode["mode"]>;
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
		this.#current = current;
		this.#options = {
			companyId: profile.profileId,
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
			fetch: async (input, init) => {
				this.current();
				// Enable the public bridge only after its deployment has been accepted.
				// This is a configured transport selection, never a fallback after a write.
				const url = new URL(input instanceof Request ? input.url : input);
				const target =
					cloud.config.memberCompanyGatewayUrl &&
					url.origin === new URL(cloud.config.objectGatewayUrl).origin &&
					url.pathname.startsWith("/v1/member-")
						? `${cloud.config.memberCompanyGatewayUrl}${url.pathname}${url.search}`
						: input;
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
	snapshot(snapshotId: string): CloudMemberCompanyFileReader {
		this.current();
		return new CloudMemberCompanyFileReader({ ...this.#options, snapshotId });
	}
	/** How this company's files are read: governed (the path gateway), a folder-v2 company's folder, or legacy. One
	 * answer serves this page's lifetime (a company's mode never changes under it); a failed read is asked again. */
	mode(): Promise<CloudMemberCompanyMode["mode"]> {
		this.current();
		this.#mode ??= this.#readMode().catch((error: unknown) => {
			this.#mode = undefined;
			throw error;
		});
		return this.#mode;
	}
	async #readMode(): Promise<CloudMemberCompanyMode["mode"]> {
		this.current();
		// The SDK validates endpoint origins before even the mode request can carry a token.
		new CloudMemberCompanyFileClient(this.#options);
		const mode = await withCloudDeadline(
			async (signal) => {
				const token = await this.#options.accessToken(signal);
				signal.throwIfAborted();
				this.current();
				const response = await this.#options.fetch!(
					`${new URL(this.#options.supabaseUrl).origin}/rest/v1/rpc/qorpera_member_company_file_mode`,
					{
						method: "POST",
						signal,
						redirect: "error",
						cache: "no-store",
						headers: {
							authorization: `Bearer ${token}`,
							apikey: this.#options.publishableKey,
							"content-type": "application/json",
						},
						body: JSON.stringify({ p_profile_id: this.#options.companyId }),
					},
				);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Company File access could not be confirmed.");
				}
				const result = parseCloudMemberCompanyMode(
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 16384, signal),
						),
					),
					this.#options.companyId,
				);
				signal.throwIfAborted();
				this.current();
				return result;
			},
			10000,
			this.signal,
		);
		// Another environment's mode is no mode for this company.
		if (mode.environmentId !== this.#options.environmentId)
			throw new Error("This company does not have a governed File interface.");
		return mode.mode;
	}
	async files(): Promise<CloudMemberCompanyFileClient> {
		const client = new CloudMemberCompanyFileClient(this.#options);
		if ((await this.mode()) !== "governed") throw new Error("This company does not have a governed File interface.");
		return client;
	}
	/** A folder-v2 company's folder, read only (folder core C4, P27). Call after `mode()` answered `folder`. */
	folder(): CloudMemberFolderClient {
		this.current();
		return new CloudMemberFolderClient({
			environmentId: this.#options.environmentId,
			supabaseUrl: this.#options.supabaseUrl,
			objectGatewayUrl: this.#options.objectGatewayUrl,
			publishableKey: this.#options.publishableKey,
			accessToken: this.#options.accessToken,
			fetch: this.#options.fetch,
		});
	}
	/** The folder's hint (folder core C4, P30): `onHint(seq)` when it changed. Closes with this company's signal. */
	folderHints(onHint: (seq: number) => void): CloudMemberFolderHints {
		this.current();
		return new CloudMemberFolderHints({
			environmentId: this.#options.environmentId,
			client: this.#realtime(),
			signal: this.signal,
			onHint,
		});
	}
	presence(onChange: (view: CompanyPathPresenceView) => void): CloudMemberCompanyPresence {
		this.current();
		return new CloudMemberCompanyPresence({
			...this.#options,
			client: this.#realtime(),
			signal: this.signal,
			onChange,
		});
	}
	#realtime() {
		return createClient(this.#options.supabaseUrl, this.#options.publishableKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
			accessToken: () => withCloudDeadline((signal) => this.#options.accessToken(signal), 2000, this.signal),
		});
	}
}
