import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CloudConfig } from "./config.ts";

/* The client is a viewing, input, approval, upload, download endpoint
 * (runtime contract §2). It holds the publishable key and the member's token,
 * nothing else. Every cloud call goes through `rpc` so failures carry the
 * PostgREST/Postgres code the views use to tell "not deployed" from "denied". */

export class CloudRpcError extends Error {
	readonly rpc: string;
	readonly code: string | undefined;
	readonly status: number | undefined;
	readonly details: string | undefined;
	readonly hint: string | undefined;

	constructor(
		rpc: string,
		error: { message: string; code?: string | null; details?: string | null; hint?: string | null },
		status?: number,
	) {
		super(error.message);
		this.name = "CloudRpcError";
		this.rpc = rpc;
		this.code = error.code ?? undefined;
		this.status = status;
		this.details = error.details ?? undefined;
		this.hint = error.hint ?? undefined;
	}

	/** PostgREST could not find the function: the machinery is not deployed. */
	get missing(): boolean {
		return this.code === "PGRST202";
	}

	/** The cloud authority refused: no membership, wrong role, or signed out. */
	get denied(): boolean {
		return this.code === "42501" || this.status === 401 || this.status === 403;
	}
}

export interface Cloud {
	readonly config: CloudConfig;
	readonly supabase: SupabaseClient;
	rpc(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function createCloud(config: CloudConfig): Cloud {
	const supabase = createClient(config.projectUrl, config.publishableKey, {
		auth: {
			flowType: "pkce",
			persistSession: true,
			autoRefreshToken: true,
			detectSessionInUrl: true,
			storageKey: "qorpera-web-auth/v1",
		},
		realtime: { params: { eventsPerSecond: 10 } },
	});
	return {
		config,
		supabase,
		async rpc(name, args = {}) {
			const { data, error, status } = await supabase.rpc(name, args);
			if (error) throw new CloudRpcError(name, error, status);
			return data;
		},
	};
}

export function describeError(error: unknown): string {
	if (error instanceof CloudRpcError) {
		if (error.missing) return `${error.rpc} is not deployed on this cloud yet.`;
		// A refusal usually says exactly what rule was hit, and that sentence is
		// worth more than a paraphrase of the code.
		if (error.denied) {
			return error.message.trim() ? error.message : "The cloud refused this operation for your account.";
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}
