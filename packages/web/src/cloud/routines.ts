import {
	type CloudRoutine,
	CloudRoutineClient,
	type CloudRoutineEffort,
	type CloudRoutineOccurrence,
	type CloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import type { Cloud } from "./client.ts";
import { planLogin, type WebMemberConnection } from "./native-subscription.ts";
import type { HostedProfile } from "./types.ts";

/** A ChatGPT plan never pays for a file-change or webhook routine (the kernel refuses it too). */
const LISTENER_ON_PLAN = "A ChatGPT plan can't pay for routines that start on a file change or a webhook.";

export interface WebRoutineDraft {
	/** Stable identity; the view keeps one per draft so a retry is the same routine. */
	clientRoutineId: string;
	staffAgentId: string;
	title: string;
	prompt: string;
	trigger: CloudRoutineTrigger;
	/** An edit keeps the routine's own (an agent may have chosen medium or high). */
	effort: CloudRoutineEffort;
	enabled: boolean;
}

/** Routines run while no member is present, so each one names the member
 * model account that pays for it, and that member consents to unattended use
 * of the account when they save. */
export interface WebRoutines {
	list(): Promise<CloudRoutine[]>;
	runs(): Promise<CloudRoutineOccurrence[]>;
	save(draft: WebRoutineDraft, account: WebMemberConnection, saveId: string): Promise<void>;
	/** Pause or resume without changing anything else. */
	setEnabled(
		routine: CloudRoutine,
		account: WebMemberConnection | undefined,
		enabled: boolean,
		saveId: string,
	): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud response");
	return value as Record<string, unknown>;
}

/** One sponsor per account version: saving again reuses it instead of piling up. */
async function sponsorKey(connectionId: string, version: number): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`qorpera.routine-sponsor/v1:${connectionId}:${version}`),
		),
	).slice(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWebRoutines(
	cloud: Cloud,
	profile: HostedProfile,
	signal: AbortSignal,
	current: () => void,
): WebRoutines {
	const check = () => {
		signal.throwIfAborted();
		current();
	};
	const rpc = async (name: string, args: Record<string, unknown>) => {
		check();
		const value = await cloud.rpc(name, args);
		check();
		return value;
	};
	const client = new CloudRoutineClient((name, args) => rpc(name, args));
	const sponsor = async (account: WebMemberConnection) => {
		if (account.connectionStatus !== "active" || account.authorizationState !== "active")
			throw new Error("This model account needs to be signed in again.");
		let version: number;
		if (planLogin(account)) {
			// A ChatGPT plan works while its member is away only once they turned that on in Settings;
			// saving a routine never turns it on for them.
			if (account.allowAutonomous !== true)
				throw new Error("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
			version = account.connectionVersion;
		} else {
			const consent = record(
				await rpc("qorpera_consent_provider_connection_autonomous", {
					p_profile_id: profile.profileId,
					p_connection_id: account.connectionId,
					p_allow_autonomous: true,
				}),
			);
			if (
				consent.connection_id !== account.connectionId ||
				consent.allow_autonomous !== true ||
				!Number.isSafeInteger(consent.version)
			)
				throw new Error("Invalid cloud response");
			version = consent.version as number;
		}
		const bound = record(
			await rpc("qorpera_create_member_execution_sponsor", {
				p_profile_id: profile.profileId,
				p_client_binding_id: await sponsorKey(account.connectionId, version),
				p_provider_connection_id: account.connectionId,
				p_provider_connection_version: version,
				p_allow_autonomous: true,
			}),
		);
		if (typeof bound.binding_id !== "string" || !Number.isSafeInteger(bound.version))
			throw new Error("Invalid cloud response");
		return { sponsorBindingId: bound.binding_id, sponsorVersion: bound.version as number };
	};
	return {
		list: () => client.list(profile.environmentId, signal),
		runs: () => client.occurrences(profile.environmentId, signal, 200),
		async save(draft, account, saveId) {
			if (draft.trigger.kind === "listener" && planLogin(account)) throw new Error(LISTENER_ON_PLAN);
			const authority = await sponsor(account);
			await client.save(
				{
					environmentId: profile.environmentId,
					clientRoutineId: draft.clientRoutineId,
					clientVersionId: saveId,
					staffAgentId: draft.staffAgentId,
					title: draft.title,
					prompt: draft.prompt,
					triggers: [draft.trigger],
					effort: draft.effort,
					enabled: draft.enabled,
					...authority,
				},
				signal,
			);
		},
		async setEnabled(routine, account, enabled, saveId) {
			const write = (authority: { sponsorBindingId: string; sponsorVersion: number }) =>
				client.save(
					{
						environmentId: profile.environmentId,
						clientRoutineId: routine.clientRoutineId,
						clientVersionId: saveId,
						staffAgentId: routine.staffAgentId,
						title: routine.title,
						prompt: routine.prompt,
						triggers: routine.triggers,
						effort: routine.effort,
						enabled,
						...authority,
					},
					signal,
				);
			try {
				// The member who set the routine up can pause it on its own account as it stands.
				await write({ sponsorBindingId: routine.sponsorBindingId, sponsorVersion: routine.sponsorVersion });
			} catch (error) {
				if (!account) throw error;
				if (planLogin(account) && routine.triggers.some((item) => item.kind === "listener"))
					throw new Error(LISTENER_ON_PLAN);
				await write(await sponsor(account));
			}
		},
	};
}
