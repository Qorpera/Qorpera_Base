import { createHash } from "node:crypto";
import { ObjectDependencyError } from "./dependency.ts";
import type { ObjectGatewayJournal } from "./journal.ts";
import type { AuthorizedObject } from "./supabase-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const MAX_OBJECT_READ_LEASE_MS = 60_000;

export interface ObjectReadLease {
	leaseId: string;
	profileId: string;
	sha256: string;
	subjectId: string;
	sessionId: string;
	issuedAt: string;
	expiresAt: string;
}

export function parseObjectReadLease(value: unknown): ObjectReadLease {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object read lease is invalid");
	const lease = value as ObjectReadLease;
	if (
		![lease.leaseId, lease.profileId, lease.subjectId, lease.sessionId].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		!HASH.test(lease.sha256 ?? "") ||
		typeof lease.issuedAt !== "string" ||
		typeof lease.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(lease.issuedAt)) ||
		!Number.isFinite(Date.parse(lease.expiresAt)) ||
		Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt) ||
		Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt) > MAX_OBJECT_READ_LEASE_MS
	) {
		throw new Error("Object read lease is invalid");
	}
	return {
		leaseId: lease.leaseId,
		profileId: lease.profileId,
		sha256: lease.sha256,
		subjectId: lease.subjectId,
		sessionId: lease.sessionId,
		issuedAt: lease.issuedAt,
		expiresAt: lease.expiresAt,
	};
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Exact, explicit RPC delegation. No JWT decoding or inferred cached identity is used. */
export class ObjectReadLeases {
	readonly #journal: ObjectGatewayJournal;
	readonly #now: () => number;

	constructor(journal: ObjectGatewayJournal, now: () => number = Date.now) {
		this.#journal = journal;
		this.#now = now;
	}

	async remember(token: string, profileId: string, sha256: string, object: AuthorizedObject): Promise<void> {
		const lease = parseObjectReadLease(object.readLease);
		if (lease.profileId !== profileId || lease.sha256 !== sha256) throw new Error("Object read lease scope mismatch");
		await this.#validate(lease, token);
		const key = `leases/${hash(`${token}:${profileId}:${sha256}`)}`;
		await this.#journal.audit({ event: "read_lease_issued", at: new Date(this.#now()).toISOString(), ...lease });
		await this.#journal.write(key, { lease, bytes: object.bytes, tokenHash: hash(token) });
	}

	async authorize(token: string, profileId: string, sha256: string): Promise<AuthorizedObject> {
		const value = await this.#journal.read(`leases/${hash(`${token}:${profileId}:${sha256}`)}`);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(503);
		const stored = value as Record<string, unknown>;
		const lease = parseObjectReadLease(stored.lease);
		if (
			lease.profileId !== profileId ||
			lease.sha256 !== sha256 ||
			stored.tokenHash !== hash(token) ||
			!Number.isSafeInteger(stored.bytes) ||
			(stored.bytes as number) < 0 ||
			(stored.bytes as number) > 8 * 1024 * 1024
		) {
			throw new ObjectDependencyError(403);
		}
		await this.#validate(lease, token);
		await this.#journal.audit({ event: "read_lease_used", at: new Date(this.#now()).toISOString(), ...lease });
		// An outage grant can read only the existing NAS replica, never the failed service.
		return { backend: "nas-object-gateway", bytes: stored.bytes as number, readLease: lease };
	}

	async rejectToken(token: string): Promise<void> {
		await this.#journal.write(`revocations/${hash(`token:${hash(token)}`)}`, { revoked: true });
		await this.#journal.audit({
			event: "read_token_revoked",
			at: new Date(this.#now()).toISOString(),
			tokenHash: hash(token),
		});
	}

	async revoke(profileId: string, subjectId?: string, sessionId?: string): Promise<void> {
		if (
			!UUID.test(profileId) ||
			(subjectId !== undefined && !UUID.test(subjectId)) ||
			(sessionId !== undefined && !UUID.test(sessionId)) ||
			(subjectId !== undefined && sessionId !== undefined)
		) {
			throw new ObjectDependencyError(400);
		}
		const scope = sessionId
			? `session:${profileId}:${sessionId}`
			: subjectId
				? `subject:${profileId}:${subjectId}`
				: `profile:${profileId}`;
		await this.#journal.write(`revocations/${hash(scope)}`, { revoked: true });
		await this.#journal.audit({
			event: "read_scope_revoked",
			at: new Date(this.#now()).toISOString(),
			profileId,
			subjectId,
			sessionId,
		});
	}

	async prune(): Promise<void> {
		for (const key of await this.#journal.list("leases")) {
			const value = await this.#journal.read(key);
			if (!value || typeof value !== "object") throw new Error("Stored object lease is invalid");
			const lease = parseObjectReadLease((value as Record<string, unknown>).lease);
			if (Date.parse(lease.expiresAt) <= this.#now()) await this.#journal.remove(key);
		}
	}

	async #validate(lease: ObjectReadLease, token: string): Promise<void> {
		await this.#journal.exclusive("clock", async () => {
			const now = this.#now();
			const prior = await this.#journal.read("clock/read-leases");
			if (prior !== undefined && (typeof prior !== "number" || !Number.isFinite(prior) || now < prior)) {
				throw new ObjectDependencyError(503);
			}
			if (Date.parse(lease.issuedAt) > now || Date.parse(lease.expiresAt) <= now)
				throw new ObjectDependencyError(403);
			await this.#journal.write("clock/read-leases", now);
		});
		for (const scope of [
			`token:${hash(token)}`,
			`profile:${lease.profileId}`,
			`subject:${lease.profileId}:${lease.subjectId}`,
			`session:${lease.profileId}:${lease.sessionId}`,
		]) {
			if ((await this.#journal.read(`revocations/${hash(scope)}`)) !== undefined)
				throw new ObjectDependencyError(403);
		}
	}
}
