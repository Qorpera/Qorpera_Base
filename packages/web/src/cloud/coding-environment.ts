import { type Cloud, CloudRpcError } from "./client.ts";
import { createSecretCapture, type HostedConnectorCaptureTicket } from "./connectors.ts";
import {
	array,
	boundedInteger,
	CloudShapeError,
	nonEmptyString,
	oneOf,
	record,
	timestamp,
	UUID_PATTERN,
	uuid,
} from "./parse.ts";

/**
 * Member surface for coding environment variables (F3 step 5j): values a coding session gets as environment
 * variables, such as a token that installs private packages. Each is a vault secret with the connector
 * `environment`, named for its variable in lower case, and captured like any typed secret: a one-time ticket from
 * the cloud, then the company's broker. The value never passes through this module's answers or Supabase.
 *
 * A member's own variables reach that member's coding sessions in every repository; a company variable reaches a
 * coding session only in a repository an owner or admin gave it to, and wins over a member's of the same name
 * there. RPCs in supabase/CLIENT-CONTRACT.md, "Coding environment variables" (migration 20260930438000).
 */

export type CodingEnvironmentOwner = "company" | "member";

export interface CodingEnvironmentGrant {
	grantId: string;
	/** owner/name, in lower case. */
	repository: string;
	issuedByUserId: string;
	createdAt: string;
}

export interface CodingEnvironmentVariable {
	secretId: string;
	/** The variable's name as a coding session sees it, in capitals. */
	name: string;
	ownerKind: CodingEnvironmentOwner;
	purpose: string;
	version: number;
	/** The repositories a company variable is given to; always empty for a member's. */
	grants: CodingEnvironmentGrant[];
	createdAt: string;
	updatedAt: string;
}

export interface CodingEnvironmentCapture {
	ownerKind: CodingEnvironmentOwner;
	name: string;
	purpose: string;
	value: string;
	/** The variable whose value this replaces; a new name has none. */
	existingSecretId?: string;
}

/** A variable's name: the kernel's rule in capitals. Names the coding machine sets itself are refused by the
 * cloud (22023), which keeps that list. */
export const CODING_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The broker's minimum (5j-3): a value shorter than this could not be masked in a coding session's output. */
export const CODING_VALUE_MINIMUM_BYTES = 8;
/** The broker's limit on any captured field. */
export const CODING_VALUE_MAXIMUM_BYTES = 32 * 1024;
/** The SQL's repository rule (owner/name, any case). */
export const CODING_REPOSITORY = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const STORED_REPOSITORY = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_][a-z0-9_.-]{0,99}$/;
/** A kept capture ticket is reused only while it has this long left; tickets live ten minutes. */
const KEPT_TICKET_MARGIN_MS = 60_000;

/** Why the broker would refuse a value, checked first so the member sees why; undefined when it would not. */
export function codingValueProblem(value: string): "short" | "long" | "nul" | undefined {
	const bytes = new TextEncoder().encode(value).length;
	if (bytes < CODING_VALUE_MINIMUM_BYTES) return "short";
	if (bytes > CODING_VALUE_MAXIMUM_BYTES) return "long";
	// An environment variable cannot hold a NUL.
	if (value.includes("\0")) return "nul";
	return undefined;
}

function parseGrant(value: unknown): CodingEnvironmentGrant {
	const input = record(value, "coding environment grant");
	const repository = input.repository;
	if (typeof repository !== "string" || !STORED_REPOSITORY.test(repository))
		throw new CloudShapeError("coding environment repository");
	return {
		grantId: uuid(input.grantId, "coding environment grant id"),
		repository,
		issuedByUserId: uuid(input.issuedByUserId, "coding environment grant issuer"),
		createdAt: timestamp(input.createdAt, "coding environment grant time"),
	};
}

export function parseCodingEnvironment(value: unknown): CodingEnvironmentVariable[] {
	return array(value, "coding environment").map((item) => {
		const input = record(item, "coding environment variable");
		if (input.schema !== "qorpera.coding-environment-secret/v1")
			throw new CloudShapeError("coding environment variable");
		const name = input.name;
		if (typeof name !== "string" || !CODING_VARIABLE_NAME.test(name))
			throw new CloudShapeError("coding environment variable name");
		return {
			secretId: uuid(input.secretId, "coding environment variable id"),
			name,
			ownerKind: oneOf(input.ownerKind, ["company", "member"], "coding environment variable owner"),
			purpose: nonEmptyString(input.purpose, "coding environment variable purpose"),
			version: boundedInteger(input.version, "coding environment variable version", 1, Number.MAX_SAFE_INTEGER),
			grants: array(input.grants, "coding environment grants").map(parseGrant),
			createdAt: timestamp(input.createdAt, "coding environment variable time"),
			updatedAt: timestamp(input.updatedAt, "coding environment variable time"),
		};
	});
}

/** A grant as giving or withdrawing it answers, in the state the call must leave it in. */
function parseGrantChange(value: unknown, status: "active" | "revoked"): CodingEnvironmentGrant {
	const input = record(value, "coding environment grant");
	if (input.schema !== "qorpera.coding-environment-grant/v1" || input.status !== status)
		throw new CloudShapeError("coding environment grant");
	uuid(input.secretId, "coding environment variable id");
	return parseGrant(input);
}

export interface WebCodingEnvironment {
	/** The company's variables and the caller's own, by name; never a value. */
	list(signal?: AbortSignal): Promise<CodingEnvironmentVariable[]>;
	/** Saves a value at the company's broker, as a new variable or over an existing one's. A try that failed after
	 * its ticket was issued leaves that ticket to the next try for the same variable. */
	capture(input: CodingEnvironmentCapture, signal?: AbortSignal): Promise<void>;
	/** Gives a company variable to one repository's coding sessions; giving it again is the same grant. */
	grant(secretId: string, repository: string, signal?: AbortSignal): Promise<CodingEnvironmentGrant>;
	revokeGrant(grantId: string, signal?: AbortSignal): Promise<void>;
	/** Removes a variable and every grant of it. */
	remove(secretId: string, signal?: AbortSignal): Promise<void>;
}

export function createWebCodingEnvironment(
	cloud: Cloud,
	profile: { profileId: string; environmentId: string },
	/** The signed-in member: a member variable is always the caller's own. */
	memberId: string,
	fetchImplementation: typeof fetch = fetch,
): WebCodingEnvironment {
	if (
		!UUID_PATTERN.test(profile.profileId) ||
		!UUID_PATTERN.test(profile.environmentId) ||
		!UUID_PATTERN.test(memberId)
	)
		throw new Error("Invalid company for coding variables.");
	const capture = createSecretCapture(cloud, profile, fetchImplementation);
	// A ticket whose send failed, by the variable it saves; never the value. SQL allows one open replacement of a
	// variable and a ticket stays open ten minutes, so the next try reuses it rather than ask for one SQL refuses.
	const kept = new Map<string, HostedConnectorCaptureTicket>();
	async function sendKeeping(
		key: string,
		issued: HostedConnectorCaptureTicket,
		fields: Readonly<Record<string, string>>,
		signal: AbortSignal | undefined,
	): Promise<void> {
		try {
			await capture.send(issued, fields, signal);
		} catch (error) {
			kept.set(key, issued);
			throw error;
		}
	}
	return {
		async list(signal) {
			signal?.throwIfAborted();
			return parseCodingEnvironment(
				await cloud.rpc("qorpera_list_coding_environment", {
					p_profile_id: profile.profileId,
					p_environment_id: profile.environmentId,
				}),
			);
		},
		async capture(input, signal) {
			signal?.throwIfAborted();
			if (!CODING_VARIABLE_NAME.test(input.name)) throw new Error("Invalid variable name.");
			// The error never carries the value.
			if (codingValueProblem(input.value)) throw new Error("The broker would refuse this value.");
			if (input.existingSecretId !== undefined && !UUID_PATTERN.test(input.existingSecretId))
				throw new Error("Invalid variable.");
			const target = {
				ownerKind: input.ownerKind,
				ownerUserId: input.ownerKind === "member" ? memberId : null,
				connectorId: "environment",
				secretName: input.name.toLowerCase(),
				purpose: input.purpose,
				existingSecretId: input.existingSecretId,
			};
			const fields = { value: input.value };
			// A ticket also fixes the purpose, so a new variable whose purpose changed asks for its own.
			const key = `${input.ownerKind}\n${input.name}\n${input.existingSecretId ?? ""}\n${input.purpose}`;
			const reused = kept.get(key);
			kept.delete(key);
			if (reused !== undefined && Date.parse(reused.expiresAt) - Date.now() > KEPT_TICKET_MARGIN_MS) {
				try {
					await capture.send(reused, fields, signal);
					return;
				} catch (error) {
					if (signal?.aborted) {
						kept.set(key, reused);
						throw error;
					}
					// The broker refuses a used ticket as it refuses any other, so the earlier try may have saved the
					// value. A fresh ticket tells: SQL refuses a second open replacement of one variable (23505).
					const fresh = await capture.ticket(target).catch((begin: unknown) => {
						const duplicate = begin instanceof CloudRpcError && begin.code === "23505";
						// For a new variable, 23505 means the earlier try saved it: the caller hears that, the ticket goes.
						if (duplicate && input.existingSecretId === undefined) throw begin;
						// Otherwise the kept ticket may still be open (a replacement's 23505 says it is, so nothing was
						// saved and the broker's error is the one to show): the next try sends with it again.
						kept.set(key, reused);
						throw duplicate ? error : begin;
					});
					await sendKeeping(key, fresh, fields, signal);
					return;
				}
			}
			await sendKeeping(key, await capture.ticket(target), fields, signal);
		},
		async grant(secretId, repository, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(secretId)) throw new Error("Invalid variable.");
			return parseGrantChange(
				await cloud.rpc("qorpera_grant_coding_environment_secret", {
					p_profile_id: profile.profileId,
					p_secret_id: secretId,
					p_repository: repository,
				}),
				"active",
			);
		},
		async revokeGrant(grantId, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(grantId)) throw new Error("Invalid grant.");
			parseGrantChange(
				await cloud.rpc("qorpera_revoke_coding_environment_grant", {
					p_profile_id: profile.profileId,
					p_grant_id: grantId,
				}),
				"revoked",
			);
		},
		async remove(secretId, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(secretId)) throw new Error("Invalid variable.");
			await cloud.rpc("qorpera_revoke_cloud_secret", { p_profile_id: profile.profileId, p_secret_id: secretId });
		},
	};
}
