import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { UUID_PATTERN } from "@qorpera/contracts";
import { ObjectDependencyError } from "./dependency.ts";
import type { FolderObjectAuthority } from "./folder-objects.ts";

/** G2-6a: whether the request's caller holds its binding's run lease (qorpera_native_binding_proven, migration
 * 20260930152000). Refuses unless it does; the locked checks behind each route still run under their locks. */
export interface NativeBindingProof {
	proveNativeBinding(binding: Record<string, unknown>, holder: string): Promise<void>;
}

/** The native host's credential and the folder core's route for folder-v2 runs (C1d). The snapshot-v1
 * /v1/native-company-objects route on the same credential is gone (legacy removal, step C). */
export interface NativeCompanyObjectOptions {
	token: string;
	folder: FolderObjectAuthority;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The native routes' bearer check: the gateway's native credential, compared in constant time. */
export function assertNativeToken(request: IncomingMessage, token: string): void {
	const header = request.headers.authorization;
	if (
		!header?.startsWith("Bearer ") ||
		!timingSafeEqual(
			createHash("sha256").update(header.slice(7)).digest(),
			createHash("sha256").update(token).digest(),
		)
	)
		throw new ObjectDependencyError(401);
}

/** The caller's holder credential (G2-6a): `job.<job id>.<lease token>` in x-qorpera-identity, as the native host's
 * dispatch gives it. Malformed or missing is 401; the value never reaches a log or an error. */
export function nativeHolder(request: IncomingMessage): string {
	const holder = request.headers["x-qorpera-identity"];
	const [kind, jobId, token, ...rest] = typeof holder === "string" ? holder.split(".") : [];
	if (kind !== "job" || !UUID_PATTERN.test(jobId ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "") || rest.length)
		throw new ObjectDependencyError(401);
	return holder as string;
}

/** The run's binding from its header: canonical base64url JSON of its ten fields. */
export function nativeBinding(request: IncomingMessage): Record<string, unknown> {
	const encoded = request.headers["x-qorpera-native-binding"];
	if (typeof encoded !== "string" || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
		throw new ObjectDependencyError(400);
	let value: unknown;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Noncanonical binding");
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ObjectDependencyError(400);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(400);
	const binding = value as Record<string, unknown>;
	const ids = ["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId"];
	if (
		ids.some((key) => typeof binding[key] !== "string" || !UUID.test(binding[key] as string)) ||
		Object.keys(binding).some((key) => ![...ids, "provider", "nativeHarness", "model"].includes(key)) ||
		binding.provider !== "openai" ||
		binding.nativeHarness !== "codex-cli" ||
		typeof binding.model !== "string" ||
		!binding.model.trim() ||
		binding.model.length > 160 ||
		/[\0\r\n]/.test(binding.model)
	)
		throw new ObjectDependencyError(400);
	return binding;
}
