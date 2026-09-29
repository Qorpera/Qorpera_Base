import { createHash, createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSecureContext } from "node:tls";
import { parseCompanyComputerBootIntentRequest, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import { LxdUnixClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import {
	exists,
	officeRecordLoose,
	openGuard,
	parseLxdOfficeRecoveryPlan,
	readJournalRecordAsRoot,
	writeProtectedPlan,
} from "./lxd-office-host-reboot.ts";
import { officeCanonical, officeRecord } from "./lxd-office-image-provenance.ts";
import { syncDirectory } from "./lxd-office-journal-files.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { OFFICE_SERVICE_CREDENTIALS } from "./lxd-office-service-bootstrap.ts";
import {
	OFFICE_SERVICE_BOOTSTRAP_REVISIONS_FILE,
	OFFICE_SERVICE_BOOTSTRAP_REVISIONS_MAX_BYTES,
	parseLxdOfficeServiceBootstrapRevisions,
} from "./lxd-office-service-bootstrap-revisions.ts";

/** Root-run beside the provider (a timer). When the node's tailnet certificate
 * differs from the one the office plan names, the office is powered off, the
 * plan revised (new credential files, retained previous plan, chain record)
 * and resumed. The provider does every guest step; this never holds its lock.
 * The certificate must be valid for the SAN the route uses and not near expiry. */
export type LxdOfficeCredentialRotationResult =
	| { state: "current"; certificateSha256: string }
	| { state: "skipped"; reason: string }
	| { state: "refused"; reason: string }
	| {
			state: "rotated";
			transitionId: string;
			revision: number;
			previousPlanSha256: string;
			planSha256: string;
			certificateSha256: string;
			notAfter: string;
			bootIntentId: string;
			activationId: string;
	  };
export interface LxdOfficeCredentialRotationPorts {
	/** Reads the node's current certificate and key (root paths). */
	readSource?: (path: string, limit: number) => Promise<Buffer>;
	guestState?: (project: string, name: string, signal: AbortSignal) => Promise<string>;
	waitMs?: number;
	pollMs?: number;
	now?: () => number;
	minValidityMs?: number;
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

async function readRoot(path: string, limit: number): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			(process.getuid?.() === 0 && info.uid !== 0) ||
			info.nlink !== 1 ||
			info.size < 1 ||
			info.size > limit
		)
			throw new Error("OFFICE_CREDENTIAL_SOURCE_UNCONFIRMED");
		return await file.readFile();
	} finally {
		await file.close();
	}
}
async function writeRootFile(path: string, bytes: Buffer, mode: number, gid: number): Promise<void> {
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(bytes);
		await handle.chmod(mode);
		if (process.getuid?.() === 0) await handle.chown(0, gid);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(dirname(path));
}

/** Validate a PEM pair for the office route name: the SAN names the domain,
 * the key matches, TLS accepts it, and it does not expire soon. */
export function parseLxdOfficeTailnetCertificate(
	certPem: Buffer,
	keyPem: Buffer,
	domain: string,
	nowMs: number,
	minValidityMs: number,
): { sha256: string; notAfter: string } {
	if (!DOMAIN.test(domain)) throw new Error("OFFICE_CREDENTIAL_DOMAIN_INVALID");
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(certPem);
		if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("key");
		createSecureContext({ cert: certPem, key: keyPem, minVersion: "TLSv1.3" });
	} catch {
		throw new Error("OFFICE_CREDENTIAL_PAIR_INVALID");
	}
	const names = (certificate.subjectAltName ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith("DNS:"))
		.map((entry) => entry.slice(4).toLowerCase());
	if (!names.includes(domain)) throw new Error("OFFICE_CREDENTIAL_NAME_DIFFERS");
	const notAfter = Date.parse(certificate.validTo);
	if (!Number.isFinite(notAfter) || notAfter - nowMs < minValidityMs) throw new Error("OFFICE_CREDENTIAL_EXPIRING");
	return { sha256: sha(certPem), notAfter: new Date(notAfter).toISOString() };
}

/** Write revision n beside the plan: the new credential files, the retained
 * previous plan, the extended chain document and finally the plan itself.
 * Only the two TLS entries change; every other plan byte stays as it was. */
export async function reviseLxdOfficeServiceBootstrapCredential(
	planPath: string,
	allocationId: string,
	certPem: Buffer,
	keyPem: Buffer,
	reason: string,
	nowMs: number,
): Promise<{ revision: number; previousPlanSha256: string; planSha256: string }> {
	const directory = dirname(planPath);
	const previous = await readRoot(planPath, 16384);
	const plan = decode(previous) as Record<string, unknown>;
	const credentials = officeRecord(plan.credentials, OFFICE_SERVICE_CREDENTIALS) as Record<
		string,
		{ path: string; bytes: number; sha256: string }
	>;
	if (credentials.tlsCert.sha256 === sha(certPem)) throw new Error("OFFICE_CREDENTIAL_ALREADY_NAMED");
	const gid = (await lstat(credentials.tlsCert.path)).gid;
	const chainPath = join(directory, OFFICE_SERVICE_BOOTSTRAP_REVISIONS_FILE);
	let revisions: unknown[] = [];
	if (await exists(chainPath)) {
		const chain = parseLxdOfficeServiceBootstrapRevisions(
			decode(await readRoot(chainPath, OFFICE_SERVICE_BOOTSTRAP_REVISIONS_MAX_BYTES)),
			allocationId,
		);
		if (chain.revisions.at(-1)?.nextSha256 !== sha(previous)) throw new Error("OFFICE_CREDENTIAL_CHAIN_HEAD_DIFFERS");
		revisions = [...chain.revisions];
	}
	const revision = revisions.length + 1;
	const files = {
		tlsCert: { path: join(directory, `tlsCert-r${revision}`), bytes: certPem },
		tlsKey: { path: join(directory, `tlsKey-r${revision}`), bytes: keyPem },
	};
	for (const file of Object.values(files))
		if (await exists(file.path)) throw new Error("OFFICE_CREDENTIAL_FILE_EXISTS");
	const next = {
		...plan,
		credentials: Object.fromEntries(
			Object.entries(credentials).map(([name, ref]) => [
				name,
				name in files
					? {
							path: files[name as keyof typeof files].path,
							bytes: files[name as keyof typeof files].bytes.length,
							sha256: sha(files[name as keyof typeof files].bytes),
						}
					: ref,
			]),
		),
	};
	const nextBytes = Buffer.from(`${JSON.stringify(next)}\n`);
	const chain = {
		schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
		allocationId,
		revisions: [
			...revisions,
			{
				revision,
				previousSha256: sha(previous),
				nextSha256: sha(nextBytes),
				previousPlan: previous.toString("utf8"),
				changed: ["tlsCert", "tlsKey"],
				reason,
				at: new Date(nowMs).toISOString(),
			},
		],
	};
	const chainBytes = Buffer.from(`${JSON.stringify(chain)}\n`);
	parseLxdOfficeServiceBootstrapRevisions(decode(chainBytes), allocationId);
	for (const file of Object.values(files)) await writeRootFile(file.path, file.bytes, 0o440, gid);
	await writeRootFile(join(directory, `service-bootstrap.json.r${revision - 1}`), previous, 0o444, 0);
	await writeRootFile(`${chainPath}.new`, chainBytes, 0o444, 0);
	if (await exists(chainPath))
		await rename(chainPath, join(directory, `${OFFICE_SERVICE_BOOTSTRAP_REVISIONS_FILE}.r${revision - 1}`));
	await rename(`${chainPath}.new`, chainPath);
	await writeRootFile(`${planPath}.new`, nextBytes, 0o444, 0);
	await rename(`${planPath}.new`, planPath);
	await syncDirectory(directory);
	if (!(await readFile(planPath)).equals(nextBytes) || !(await readFile(chainPath)).equals(chainBytes))
		throw new Error("OFFICE_CREDENTIAL_REVISION_UNCONFIRMED");
	return { revision, previousPlanSha256: sha(previous), planSha256: sha(nextBytes) };
}

export async function runLxdOfficeCredentialRotation(
	configPath: string,
	domain: string,
	signal: AbortSignal,
	ports: LxdOfficeCredentialRotationPorts = {},
): Promise<LxdOfficeCredentialRotationResult> {
	const now = ports.now ?? Date.now,
		readSource = ports.readSource ?? readRoot,
		waitMs = ports.waitMs ?? 240000,
		pollMs = ports.pollMs ?? 2000,
		minValidityMs = ports.minValidityMs ?? 14 * 86400000;
	if (!DOMAIN.test(domain)) throw new Error("OFFICE_CREDENTIAL_DOMAIN_INVALID");
	const guard = await openGuard(configPath, signal);
	if (guard.retired) return { state: "skipped", reason: "office retired" };
	const lifecycle = officeRecordLoose(decode(await readLxdOfficeProtectedFile(guard.planPath, 65536)));
	const planPath = officePhysicalPath(officeRecordLoose(lifecycle.request).serviceBootstrapPath);
	const planBytes = await readLxdOfficeProtectedFile(planPath, 16384);
	const planCredentials = officeRecord(officeRecordLoose(decode(planBytes)).credentials, OFFICE_SERVICE_CREDENTIALS);
	const namedCertificate = officeRecord(planCredentials.tlsCert, ["path", "bytes", "sha256"]).sha256;
	const certPem = await readSource(`/var/lib/tailscale/certs/${domain}.crt`, 65536),
		keyPem = await readSource(`/var/lib/tailscale/certs/${domain}.key`, 32768);
	const certificate = parseLxdOfficeTailnetCertificate(certPem, keyPem, domain, now(), minValidityMs);
	if (namedCertificate === certificate.sha256) return { state: "current", certificateSha256: certificate.sha256 };
	// Same admission as the host guard: an active office, no pending transition.
	const status = officeRecordLoose(
		await guard.registry.call("qorpera_runtime_office_provider_status", guard.identity, signal),
	);
	if (status.officeState !== "active") return { state: "skipped", reason: `office ${String(status.officeState)}` };
	const recoveryPath = `${guard.planPath}.recovery`,
		resumePath = `${guard.planPath}.resume`;
	if (await exists(resumePath)) return { state: "refused", reason: "stale resume plan" };
	const activation = officeRecordLoose(
		await guard.registry.call("qorpera_runtime_office_provider_activation", guard.identity, signal),
	);
	if (activation.schema !== "qorpera.office-provider-activation/v1" || !activation.activation)
		return { state: "skipped", reason: "no active activation" };
	const active = officeRecord(activation.activation, [
		"activationId",
		"providerId",
		"providerPolicySha256",
		"startup",
	]);
	if (await exists(recoveryPath)) {
		const previous = parseLxdOfficeRecoveryPlan(decode(await readLxdOfficeProtectedFile(recoveryPath, 65536)));
		const suffix = `${previous.request.startup.allocationId}-${previous.request.transitionId}`;
		const completed = ["power_off", "reboot"].includes(previous.request.action)
			? await exists(join(guard.root, `resume-completed-${suffix}.json`))
			: await exists(
					join(
						guard.root,
						`successor-completed-${previous.request.startup.allocationId}-${previous.request.activationId}.json`,
					),
				);
		if (!completed || active.activationId === previous.request.activationId)
			return { state: "refused", reason: "previous transition pending" };
		const stamp = new Date(now())
			.toISOString()
			.replaceAll(/[-:]/g, "")
			.replace(/\.\d+Z$/, "Z");
		const archive = join(
			dirname(guard.planPath),
			`archive-lifecycle-${previous.request.transitionId.slice(0, 8)}-${stamp}`,
		);
		await mkdir(archive, { mode: 0o700 });
		for (const path of [recoveryPath, resumePath])
			if (await exists(path)) await rename(path, join(archive, path.slice(path.lastIndexOf("/") + 1)));
		await syncDirectory(dirname(guard.planPath));
	}
	const request = parseCompanyComputerLifecycleRequest({
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId: randomUUID(),
		action: "power_off",
		activationId: active.activationId,
		providerId: active.providerId,
		providerPolicySha256: active.providerPolicySha256,
		startup: active.startup,
	});
	if (
		request.providerId !== guard.identity.p_provider_id ||
		request.providerPolicySha256 !== guard.identity.p_provider_policy_sha256
	)
		throw new Error("OFFICE_CREDENTIAL_ACTIVATION_DIFFERS");
	const allocationId = request.startup.allocationId;
	await writeProtectedPlan(
		recoveryPath,
		Buffer.from(officeCanonical({ schema: "qorpera.lxd-office-recovery-plan/v1", request })),
	);
	const suffix = `${allocationId}-${request.transitionId}`,
		started = now();
	for (;;) {
		signal.throwIfAborted();
		if (await exists(join(guard.root, `power-off-completed-${suffix}.json`))) break;
		if (now() - started >= waitMs) return { state: "refused", reason: "power-off incomplete" };
		await delay(pollMs, undefined, { signal });
	}
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		...guard.policy.guest,
		allocationId,
		providerPolicySha256: guard.identity.p_provider_policy_sha256,
	};
	const guest = lxdOfficeGuestPlan(binding);
	const guestState =
		ports.guestState ??
		(async (project: string, name: string, checked: AbortSignal) =>
			(await new LxdUnixClient(guard.policy.host.socketPath).getInstance(project, name, checked))?.status ??
			"absent");
	if ((await guestState(guest.binding.project, guest.request.name, signal)) !== "Stopped")
		return { state: "refused", reason: "guest not stopped" };
	const revised = await reviseLxdOfficeServiceBootstrapCredential(
		planPath,
		allocationId,
		certPem,
		keyPem,
		`node tailnet certificate ${certificate.sha256.slice(0, 12)} (valid to ${certificate.notAfter}) replaced the one the plan named`,
		now(),
	);
	const history = (await readJournalRecordAsRoot(join(guard.root, `power-off-history-${suffix}.json`), 16 * 1024 ** 2))
			.bytes,
		completion = (await readJournalRecordAsRoot(join(guard.root, `power-off-completed-${suffix}.json`), 65536)).bytes;
	const resume = parseCompanyComputerBootIntentRequest({
		schema: "qorpera.office-boot-intent-request/v1",
		bootIntentId: randomUUID(),
		activationId: randomUUID(),
		predecessor: request,
		stopHistorySha256: sha(history),
		powerOffCompletionSha256: sha(completion),
	});
	await writeProtectedPlan(
		resumePath,
		Buffer.from(officeCanonical({ schema: "qorpera.lxd-office-resume-plan/v1", request: resume })),
	);
	return {
		state: "rotated",
		transitionId: request.transitionId,
		...revised,
		certificateSha256: certificate.sha256,
		notAfter: certificate.notAfter,
		bootIntentId: resume.bootIntentId,
		activationId: resume.activationId,
	};
}
