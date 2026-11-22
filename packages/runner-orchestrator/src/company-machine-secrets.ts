import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { parseUuid } from "@qorpera/contracts";
import { buildAppSecretMask } from "./coding-command-secrets.ts";
import { CODING_SECRET_MASK_MINIMUM_BYTES, CodingSecretMask } from "./coding-secret-mask.ts";

export const APP_SECRETS_TMPFS_DIR = "/run/qorpera-apps";
export const APP_SECRETS_FILE_MODE = 0o400;
export const APP_SECRETS_DIR_MODE = 0o700;
export const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const APP_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const APP_ENV_REFUSED_PREFIX = /^(LC|GIT|LD|DYLD|QORPERA|SSH|XDG|DOCKER|CLAUDE|CODEX)_/;
const APP_ENV_RESERVED = new Set([
	"HOME",
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
	"COLORTERM",
	"COLUMNS",
	"LINES",
	"LANG",
	"LANGUAGE",
	"TZ",
	"BASH_ENV",
	"ENV",
	"IFS",
	"PS1",
	"PS2",
	"PS4",
	"PROMPT_COMMAND",
	"SHELLOPTS",
	"BASHOPTS",
	"CDPATH",
	"GLOBIGNORE",
	"HOSTNAME",
	"SHLVL",
	"MAIL",
	"MAILPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"FTP_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
]);
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_ENV_FILE_BYTES = 256 * 1024;
const TMPFS_TYPES = new Set(["tmpfs", "ramfs"]);

export type HostedAppSecretScope = "build" | "test" | "runtime";
export type HostedAppTargetEnv = "dev" | "prod";

export interface HostedAppSecretBundle {
	readonly siteId: string;
	readonly slug: string;
	readonly scope: HostedAppSecretScope;
	readonly targetEnv: HostedAppTargetEnv;
	readonly secrets: Readonly<Record<string, string>>;
	readonly config?: Readonly<Record<string, string>>;
	readonly databaseUrl?: string;
	readonly maskHistory?: readonly string[];
}

export interface HostedAppDeliveredSecrets {
	readonly siteId: string;
	readonly slug: string;
	readonly envPath: string;
	readonly secretNames: readonly string[];
	readonly mask: CodingSecretMask;
	scrub(): Promise<void>;
}

export interface GuestDeliverAppSecretsPlan {
	readonly slug: string;
	readonly envPath: string;
	readonly secretNames: readonly string[];
	readonly command: readonly string[];
	readonly stdin: Buffer;
	readonly mask: CodingSecretMask;
}

export type TmpfsVerifier = (dir: string) => Promise<boolean>;

export function validateAppSlug(slug: string): string {
	if (typeof slug !== "string" || !APP_SLUG_PATTERN.test(slug)) {
		throw new RangeError("Hosted app slug is invalid");
	}
	return slug;
}

export function appSecretEnvNameAllowed(name: string): boolean {
	return (
		typeof name === "string" &&
		APP_ENV_NAME_PATTERN.test(name) &&
		!APP_ENV_REFUSED_PREFIX.test(name) &&
		!APP_ENV_RESERVED.has(name)
	);
}

function validateRootDir(rootDir: string): string {
	if (typeof rootDir !== "string" || !rootDir.startsWith("/") || rootDir.includes("\0")) {
		throw new RangeError("Hosted app secrets rootDir must be an absolute path");
	}
	return resolve(rootDir);
}

export function appSecretEnvPath(slug: string, rootDir: string = APP_SECRETS_TMPFS_DIR): string {
	return join(validateRootDir(rootDir), `${validateAppSlug(slug)}.env`);
}

function validateSecretValue(value: string, sensitive: boolean): void {
	if (typeof value !== "string" || value.includes("\0") || LONE_SURROGATE.test(value)) {
		throw new RangeError("Hosted app environment value is invalid");
	}
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > MAX_VALUE_BYTES) {
		throw new RangeError("Hosted app environment value exceeds maximum size");
	}
	if (sensitive && bytes < CODING_SECRET_MASK_MINIMUM_BYTES) {
		throw new RangeError(`a coding secret shorter than ${CODING_SECRET_MASK_MINIMUM_BYTES} bytes can't be masked`);
	}
}

function escapeDotenvValue(value: string): string {
	let out = '"';
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i]!;
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "$") out += "\\$";
		else if (ch === "`") out += "\\`";
		else out += ch;
	}
	return `${out}"`;
}

function prepareAppEnvironment(
	bundle: HostedAppSecretBundle,
	expectedScope: HostedAppSecretScope = "runtime",
): {
	readonly envBuffer: Buffer;
	readonly secretNames: readonly string[];
	readonly mask: CodingSecretMask;
} {
	parseUuid(bundle.siteId, "Hosted app siteId");
	validateAppSlug(bundle.slug);
	if (bundle.scope !== expectedScope) {
		throw new RangeError(`Hosted app tmpfs delivery only accepts ${expectedScope} scope secrets`);
	}
	if (bundle.targetEnv !== "dev" && bundle.targetEnv !== "prod") {
		throw new RangeError("Hosted app target environment is invalid");
	}
	const mergedSecrets: Record<string, string> = {};
	const mergedEnv: Record<string, string> = {};
	if (bundle.config) {
		for (const [name, value] of Object.entries(bundle.config)) {
			if (!appSecretEnvNameAllowed(name)) throw new RangeError(`Hosted app config name is not allowed: ${name}`);
			validateSecretValue(value, false);
			mergedEnv[name] = value;
		}
	}
	const extraMaskValues: string[] = [...(bundle.maskHistory ?? [])];
	for (const value of extraMaskValues) validateSecretValue(value, true);
	if (bundle.databaseUrl !== undefined) {
		validateSecretValue(bundle.databaseUrl, true);
		mergedSecrets.DATABASE_URL = bundle.databaseUrl;
		mergedEnv.DATABASE_URL = bundle.databaseUrl;
		extraMaskValues.push(bundle.databaseUrl);
	}
	for (const [name, value] of Object.entries(bundle.secrets)) {
		if (!appSecretEnvNameAllowed(name)) throw new RangeError(`Hosted app secret name is not allowed: ${name}`);
		validateSecretValue(value, true);
		mergedSecrets[name] = value;
		mergedEnv[name] = value;
	}
	const mask = buildAppSecretMask(mergedSecrets, extraMaskValues);
	const envBuffer = formatAppEnvFile(mergedEnv);
	const secretNames = Object.freeze(Object.keys(mergedSecrets).sort());
	return { envBuffer, secretNames, mask };
}

export function formatAppEnvFile(entries: Readonly<Record<string, string>>): Buffer {
	const names = Object.keys(entries).sort();
	const lines: string[] = [];
	for (const name of names) {
		if (!appSecretEnvNameAllowed(name)) {
			throw new RangeError(`Hosted app environment variable name is not allowed: ${name}`);
		}
		const value = entries[name]!;
		if (typeof value !== "string" || value.includes("\0") || LONE_SURROGATE.test(value)) {
			throw new RangeError("Hosted app environment value is invalid");
		}
		lines.push(`${name}=${escapeDotenvValue(value)}`);
	}
	const payload = Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
	if (payload.byteLength > MAX_ENV_FILE_BYTES) {
		payload.fill(0);
		throw new RangeError("Hosted app environment file exceeds maximum size");
	}
	return payload;
}

function unescapeMountPath(raw: string): string {
	return raw.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export async function isTmpfsMountedPath(
	targetPath: string,
	readMounts: () => Promise<string> = () => readFile("/proc/mounts", "utf8"),
): Promise<boolean> {
	let content: string;
	try {
		content = await readMounts();
	} catch {
		return false;
	}
	const resolved = resolve(targetPath);
	let bestMount = "";
	let bestFs = "";
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = trimmed.split(/\s+/);
		if (fields.length < 3) continue;
		const mountPoint = unescapeMountPath(fields[1]!);
		const fsType = fields[2]!;
		const matches =
			mountPoint === "/" || resolved === mountPoint || resolved.startsWith(`${mountPoint.replace(/\/+$/, "")}/`);
		if (matches && mountPoint.length >= bestMount.length) {
			bestMount = mountPoint;
			bestFs = fsType;
		}
	}
	return TMPFS_TYPES.has(bestFs);
}

export function createMaskedAppLogStream(mask: CodingSecretMask): Transform {
	const stream = mask.stream();
	return new Transform({
		transform(chunk, _encoding, callback) {
			try {
				const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), "utf8");
				const masked = stream.push(bytes);
				if (masked.byteLength > 0) this.push(masked);
				callback();
			} catch (error) {
				callback(error instanceof Error ? error : new Error("App log masking failed"));
			}
		},
		flush(callback) {
			try {
				const tail = stream.end();
				if (tail.byteLength > 0) this.push(tail);
				callback();
			} catch (error) {
				callback(error instanceof Error ? error : new Error("App log masking flush failed"));
			}
		},
	});
}

export function maskAppLogText(mask: CodingSecretMask, text: string): string {
	const stream = mask.stream();
	const head = stream.push(Buffer.from(text, "utf8"));
	const tail = stream.end();
	return Buffer.concat([head, tail]).toString("utf8");
}

export function buildGuestDeliverAppSecretsPlan(
	bundle: HostedAppSecretBundle,
	rootDir: string = APP_SECRETS_TMPFS_DIR,
): GuestDeliverAppSecretsPlan {
	const slug = validateAppSlug(bundle.slug);
	const validRoot = validateRootDir(rootDir);
	const envPath = appSecretEnvPath(slug, validRoot);
	const { envBuffer, secretNames, mask } = prepareAppEnvironment(bundle);
	const script = [
		"set -eu",
		'dir="$1"',
		'target="$2"',
		'if [ -L "$dir" ] || [ -L "$target" ]; then echo "APP_SECRETS_SYMLINK_REFUSED" >&2; exit 71; fi',
		'mkdir -p -m 0700 "$dir"',
		'chmod 0700 "$dir"',
		'fstype="$(stat -f -c %T "$dir" 2>/dev/null || true)"',
		'if [ "$fstype" != "tmpfs" ] && [ "$fstype" != "ramfs" ]; then echo "APP_SECRETS_NOT_TMPFS" >&2; exit 70; fi',
		'tmp="$target.tmp.$$"',
		"trap 'rm -f \"$tmp\"' EXIT",
		"umask 0177",
		'cat > "$tmp"',
		'chmod 0400 "$tmp"',
		'mv -f "$tmp" "$target"',
	].join("\n");
	return Object.freeze({
		slug,
		envPath,
		secretNames,
		command: Object.freeze(["sh", "-c", script, "--", validRoot, envPath]),
		stdin: envBuffer,
		mask,
	});
}

export function buildGuestScrubAppSecretsCommand(
	slug: string,
	rootDir: string = APP_SECRETS_TMPFS_DIR,
): readonly string[] {
	const envPath = appSecretEnvPath(slug, rootDir);
	const script = [
		"set -eu",
		'target="$1"',
		'if [ -L "$target" ]; then rm -f "$target"; elif [ -f "$target" ]; then chmod 0600 "$target" 2>/dev/null || true; : > "$target"; rm -f "$target"; fi',
	].join("\n");
	return Object.freeze(["sh", "-c", script, "--", envPath]);
}

async function scrubFile(filePath: string): Promise<void> {
	try {
		const info = await lstat(filePath);
		if (info.isSymbolicLink()) {
			await unlink(filePath);
			return;
		}
		if (info.isFile()) {
			await chmod(filePath, 0o600);
			const handle = await open(filePath, "r+");
			try {
				const stat = await handle.stat();
				if (stat.size > 0) {
					const zeros = Buffer.alloc(Math.min(stat.size, 65_536), 0);
					let offset = 0;
					while (offset < stat.size) {
						const len = Math.min(zeros.byteLength, stat.size - offset);
						await handle.write(zeros, 0, len, offset);
						offset += len;
					}
				}
			} finally {
				await handle.close();
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
	}
	try {
		await unlink(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
	}
}

export async function fetchHostedAppSecrets(options: {
	readonly brokerOrigin: string;
	readonly executorToken: string;
	readonly executorOwner: string;
	readonly machineIdSha256: string;
	readonly deploymentId?: string;
	readonly companyId?: string;
	readonly siteId: string;
	readonly scope: HostedAppSecretScope;
	readonly targetEnv: HostedAppTargetEnv;
	readonly fetchImpl?: typeof fetch;
	readonly signal: AbortSignal;
}): Promise<HostedAppSecretBundle> {
	const siteId = parseUuid(options.siteId, "Hosted app siteId");
	if (options.scope !== "build" && options.scope !== "test" && options.scope !== "runtime") {
		throw new RangeError("Hosted app secret scope is invalid");
	}
	if (options.targetEnv !== "dev" && options.targetEnv !== "prod") {
		throw new RangeError("Hosted app target environment is invalid");
	}
	if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.executorOwner)) {
		throw new RangeError("Hosted app executorOwner is invalid");
	}
	if (!/^[0-9a-f]{64}$/i.test(options.machineIdSha256)) {
		throw new RangeError("Hosted app machineIdSha256 is invalid");
	}
	const deploymentId =
		options.deploymentId === undefined ? undefined : parseUuid(options.deploymentId, "Hosted app deploymentId");
	if (options.scope === "runtime" && deploymentId === undefined) {
		throw new RangeError("Hosted app runtime secrets require deploymentId");
	}
	const url = new URL("/v1/app-secrets", options.brokerOrigin);
	if (options.companyId !== undefined) {
		url.searchParams.set("company", parseUuid(options.companyId, "Hosted app companyId").toLowerCase());
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const res = await fetchImpl(url.toString(), {
		method: "POST",
		redirect: "manual",
		headers: {
			authorization: `Bearer ${options.executorToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			schema: "qorpera.app-secrets-request/v1",
			siteId,
			scope: options.scope,
			targetEnv: options.targetEnv,
			executorOwner: options.executorOwner,
			machineIdSha256: options.machineIdSha256.toLowerCase(),
			...(deploymentId === undefined ? {} : { deploymentId }),
		}),
		signal: options.signal,
	});
	if (res.status !== 200) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`APP_SECRETS_BROKER_FAILED_${res.status}`);
	}
	const raw = (await res.json()) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("APP_SECRETS_BROKER_INVALID");
	}
	const body = raw as Record<string, unknown>;
	if (
		body.schema !== "qorpera.app-secrets/v1" ||
		typeof body.siteId !== "string" ||
		body.siteId.toLowerCase() !== siteId.toLowerCase() ||
		typeof body.slug !== "string" ||
		!APP_SLUG_PATTERN.test(body.slug) ||
		body.scope !== options.scope ||
		body.targetEnv !== options.targetEnv ||
		!body.secrets ||
		typeof body.secrets !== "object" ||
		Array.isArray(body.secrets)
	) {
		throw new Error("APP_SECRETS_BROKER_INVALID");
	}
	const secrets: Record<string, string> = {};
	for (const [name, value] of Object.entries(body.secrets as Record<string, unknown>)) {
		if (!appSecretEnvNameAllowed(name) || typeof value !== "string") {
			throw new Error("APP_SECRETS_BROKER_INVALID");
		}
		validateSecretValue(value, true);
		secrets[name] = value;
	}
	return Object.freeze({
		siteId,
		slug: body.slug,
		scope: options.scope,
		targetEnv: options.targetEnv,
		secrets: Object.freeze(secrets),
	});
}

export class CompanyMachineSecretsManager {
	readonly #rootDir: string;
	readonly #verifyTmpfs: TmpfsVerifier;
	readonly #active = new Map<string, { readonly envPath: string; readonly mask: CodingSecretMask }>();

	constructor(options?: { readonly rootDir?: string; readonly verifyTmpfs?: TmpfsVerifier }) {
		this.#rootDir = validateRootDir(options?.rootDir ?? APP_SECRETS_TMPFS_DIR);
		this.#verifyTmpfs = options?.verifyTmpfs ?? isTmpfsMountedPath;
	}

	async #writeAtomicEnv(targetPath: string, slug: string, envBuffer: Buffer): Promise<void> {
		const tmpfsOk = await this.#verifyTmpfs(this.#rootDir);
		if (!tmpfsOk) {
			throw new Error("APP_SECRETS_NOT_TMPFS");
		}
		await mkdir(dirname(targetPath), { recursive: true, mode: APP_SECRETS_DIR_MODE });
		const tmpPath = join(dirname(targetPath), `.${slug}.${randomBytes(8).toString("hex")}.tmp`);
		const handle = await open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(envBuffer);
			await handle.chmod(APP_SECRETS_FILE_MODE);
		} catch (error) {
			await handle.close().catch(() => undefined);
			await unlink(tmpPath).catch(() => undefined);
			throw error;
		}
		await handle.close();
		await rename(tmpPath, targetPath);
	}

	async deliver(bundle: HostedAppSecretBundle): Promise<HostedAppDeliveredSecrets> {
		const slug = validateAppSlug(bundle.slug);
		const envPath = appSecretEnvPath(slug, this.#rootDir);
		const { envBuffer, secretNames, mask } = prepareAppEnvironment(bundle, "runtime");
		try {
			await this.#writeAtomicEnv(envPath, slug, envBuffer);
			this.#active.set(slug, { envPath, mask });
			return Object.freeze({
				siteId: bundle.siteId,
				slug,
				envPath,
				secretNames,
				mask,
				scrub: () => this.scrub(slug),
			});
		} finally {
			envBuffer.fill(0);
		}
	}

	async deliverBuild(bundle: HostedAppSecretBundle): Promise<HostedAppDeliveredSecrets> {
		const slug = validateAppSlug(bundle.slug);
		const envPath = join(this.#rootDir, `.${slug}.build.${randomBytes(8).toString("hex")}.env`);
		const { envBuffer, secretNames, mask } = prepareAppEnvironment(bundle, "build");
		try {
			await this.#writeAtomicEnv(envPath, slug, envBuffer);
			return Object.freeze({
				siteId: bundle.siteId,
				slug,
				envPath,
				secretNames,
				mask,
				scrub: () => scrubFile(envPath),
			});
		} finally {
			envBuffer.fill(0);
		}
	}

	async snapshot(slug: string): Promise<Buffer | null> {
		const envPath = appSecretEnvPath(slug, this.#rootDir);
		try {
			const info = await lstat(envPath);
			if (!info.isFile()) return null;
			return await readFile(envPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
			throw error;
		}
	}

	async restore(slug: string, previousBytes: Buffer | null): Promise<void> {
		const validSlug = validateAppSlug(slug);
		if (previousBytes === null) {
			await this.scrub(validSlug);
			return;
		}
		const envPath = appSecretEnvPath(validSlug, this.#rootDir);
		await this.#writeAtomicEnv(envPath, validSlug, previousBytes);
	}

	maskFor(slug: string): CodingSecretMask | null {
		return this.#active.get(validateAppSlug(slug))?.mask ?? null;
	}

	createLogMaskStream(slug: string): Transform {
		const mask = this.maskFor(slug) ?? new CodingSecretMask();
		return createMaskedAppLogStream(mask);
	}

	maskLogText(slug: string, text: string): string {
		const mask = this.maskFor(slug);
		return mask ? maskAppLogText(mask, text) : text;
	}

	async scrub(slug: string): Promise<void> {
		const validSlug = validateAppSlug(slug);
		const active = this.#active.get(validSlug);
		const envPath = active?.envPath ?? appSecretEnvPath(validSlug, this.#rootDir);
		this.#active.delete(validSlug);
		await scrubFile(envPath);
	}

	async scrubAll(): Promise<void> {
		const slugs = [...this.#active.keys()];
		for (const slug of slugs) {
			await this.scrub(slug);
		}
	}
}
