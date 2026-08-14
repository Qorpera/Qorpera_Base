/**
 * Cryptographic founder identity (manifesto §3.1, invariant 15).
 *
 * Until now "founder" meant "whoever operates this machine's kernel". This
 * module gives the founder a durable ed25519 identity and makes policy
 * provenance verifiable: `authority.toml` carries a detached signature
 * (`.qorpera/authority.sig.json`), and the authority layer refuses to
 * honor UNVERIFIED policy once a founder identity exists — unsigned,
 * tampered, or signed-by-a-different-founder policy falls back to
 * everything-gated rather than granting auto/notify modes. Machines with
 * no founder identity keep today's semantics, so adoption is opt-in and
 * then enforced.
 *
 * Key handling: the private key lives in the foundation's machine-local
 * agent directory (mode 0600, outside every company folder) and is used by
 * founder-context code — the CLI and the desktop kernel. The controller's
 * normal identity API sees only the projected PUBLIC key
 * (`founder-public.json`), enough to verify, never to sign. A host-capable
 * controller still runs as the same OS user and could deliberately locate
 * the foundation file, so this separation protects the ordinary Qorpera
 * flow rather than forming an OS confidentiality boundary. The signature
 * sidecar travels with exports and forks as data: a fork
 * verified against a DIFFERENT local founder key simply fails closed to
 * all-gate until the new founder ratifies — severed authority, again
 * structurally.
 */

import { createHash, generateKeyPairSync, sign as signRaw, verify as verifyRaw } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const FOUNDER_IDENTITY_FILE = "founder-identity.json";
/** Public-only projection the kernel writes into a child's agent dir. */
export const FOUNDER_PUBLIC_FILE = "founder-public.json";
export const AUTHORITY_SIGNATURE_PATH = join(".qorpera", "authority.sig.json");

const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface FounderIdentity {
	version: 1;
	name?: string;
	publicKeyPem: string;
	privateKeyPem?: string;
	createdAt: string;
}

export interface AuthoritySignature {
	version: 1;
	contentSha256: string;
	/** base64 ed25519 signature over the raw authority.toml bytes. */
	signature: string;
	publicKeyPem: string;
	signedAt: string;
}

export type PolicyProvenance = "no-identity" | "valid" | "unsigned" | "invalid";

function identityPath(): string {
	return join(getAgentDir(), FOUNDER_IDENTITY_FILE);
}

function publicProjectionPath(): string {
	return join(getAgentDir(), FOUNDER_PUBLIC_FILE);
}

/** The founder identity visible through this context's configured agent directory. */
export function readFounderIdentity(): FounderIdentity | undefined {
	for (const path of [identityPath(), publicProjectionPath()]) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as FounderIdentity;
			if (parsed.version === 1 && typeof parsed.publicKeyPem === "string" && parsed.publicKeyPem) return parsed;
		} catch {
			// Unusable file — fall through; founderIdentityPresent() keeps
			// enforcement on so corruption can never fail open.
		}
	}
	return undefined;
}

/**
 * Does ANY founder identity file exist in this context, readable or not?
 * A present-but-corrupt identity must keep enforcement on: verification
 * treats it as "invalid" (all-gate), never as "no-identity" (legacy).
 */
export function founderIdentityPresent(): boolean {
	return existsSync(identityPath()) || existsSync(publicProjectionPath());
}

export function generateFounderIdentity(name?: string): FounderIdentity {
	if (existsSync(identityPath())) {
		throw new Error(`A founder identity already exists at ${identityPath()}`);
	}
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const identity: FounderIdentity = {
		version: 1,
		...(name ? { name } : {}),
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		createdAt: new Date().toISOString(),
	};
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(identityPath(), `${JSON.stringify(identity, null, "\t")}\n`, FILE_WRITE_OPTIONS);
	return identity;
}

/** The public-only projection content for a controller's agent directory. */
export function founderPublicProjection(): string | undefined {
	const identity = readFounderIdentity();
	if (!identity) return undefined;
	const projection: FounderIdentity = {
		version: 1,
		...(identity.name ? { name: identity.name } : {}),
		publicKeyPem: identity.publicKeyPem,
		createdAt: identity.createdAt,
	};
	return `${JSON.stringify(projection, null, "\t")}\n`;
}

/**
 * Ratify the company's authority policy: sign the raw authority.toml bytes
 * with the founder's private key and write the detached sidecar. Founder
 * contexts only (the private key is required).
 */
export function signAuthorityPolicy(root: string): AuthoritySignature {
	const identity = readFounderIdentity();
	if (!identity?.privateKeyPem) {
		throw new Error("Ratifying policy requires the founder identity ('qorpera founder init' first)");
	}
	const policy = readFileSync(join(root, "authority.toml"));
	const record: AuthoritySignature = {
		version: 1,
		contentSha256: createHash("sha256").update(policy).digest("hex"),
		signature: signRaw(null, policy, identity.privateKeyPem).toString("base64"),
		publicKeyPem: identity.publicKeyPem,
		signedAt: new Date().toISOString(),
	};
	mkdirSync(join(root, ".qorpera"), { recursive: true });
	writeFileSync(join(root, AUTHORITY_SIGNATURE_PATH), `${JSON.stringify(record, null, "\t")}\n`, "utf-8");
	return record;
}

function gateApprovalMessage(gateId: string, requestHash: string): Buffer {
	return Buffer.from(`qorpera_gate_approval\n${gateId}\n${requestHash}`, "utf-8");
}

/**
 * Sign a gate approval: the founder attests to exactly this request
 * (id + request hash). The signature survives the approved→consumed
 * status transition — it attests the approval, not the lifecycle.
 */
export function signGateApproval(gateId: string, requestHash: string): string {
	const identity = readFounderIdentity();
	if (!identity?.privateKeyPem) {
		throw new Error("Signing a gate approval requires the founder identity ('qorpera founder init' first)");
	}
	return signRaw(null, gateApprovalMessage(gateId, requestHash), identity.privateKeyPem).toString("base64");
}

/**
 * Approval provenance against THIS machine's founder identity.
 * "no-identity": legacy semantics — a status edit is an approval.
 * "valid"/"invalid": with an identity, only a signed approval counts.
 */
export function verifyGateApproval(
	gateId: string,
	requestHash: string,
	signature: string | undefined,
): PolicyProvenance {
	const identity = readFounderIdentity();
	if (!identity) return founderIdentityPresent() ? "invalid" : "no-identity";
	if (!signature) return "unsigned";
	try {
		return verifyRaw(
			null,
			gateApprovalMessage(gateId, requestHash),
			identity.publicKeyPem,
			Buffer.from(signature, "base64"),
		)
			? "valid"
			: "invalid";
	} catch {
		return "invalid";
	}
}

/**
 * Verify policy provenance against THIS machine's founder identity.
 * "no-identity": no founder key in this context — legacy semantics apply.
 * "valid": the local founder signed exactly these policy bytes.
 * "unsigned": identity exists but no sidecar — policy must fall back to gate.
 * "invalid": sidecar present but wrong key, wrong content, or bad signature.
 */
export function verifyAuthorityPolicy(root: string): PolicyProvenance {
	const identity = readFounderIdentity();
	if (!identity) return founderIdentityPresent() ? "invalid" : "no-identity";
	const sidecarPath = join(root, AUTHORITY_SIGNATURE_PATH);
	if (!existsSync(sidecarPath)) return "unsigned";
	try {
		const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as AuthoritySignature;
		if (sidecar.version !== 1 || sidecar.publicKeyPem !== identity.publicKeyPem) return "invalid";
		const policy = readFileSync(join(root, "authority.toml"));
		if (createHash("sha256").update(policy).digest("hex") !== sidecar.contentSha256) return "invalid";
		return verifyRaw(null, policy, identity.publicKeyPem, Buffer.from(sidecar.signature, "base64"))
			? "valid"
			: "invalid";
	} catch {
		return "invalid";
	}
}
