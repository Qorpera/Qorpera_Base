import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	isStaffCharacterId,
	STAFF_CHARACTER_BY_TEMPLATE,
	STAFF_CHARACTER_IDS,
	type StaffCharacterId,
} from "@qorpera/cloud-client/staff-characters";
import type { CompanyComputerGuestBoundary } from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";

/** Reused from the older screen agent and renderer; keep desktop and agent card identities aligned. */
export function companyComputerScreenCreature(
	binding: CompanyComputerScreenBinding,
	templateId?: string,
	creature?: string,
): StaffCharacterId {
	assertCompanyComputerScreenBinding(binding, binding);
	if (isStaffCharacterId(creature)) return creature;
	const mapped = Object.entries(STAFF_CHARACTER_BY_TEMPLATE).find(([id]) => id === templateId);
	if (mapped) return mapped[1];
	let seed = 0;
	for (const character of binding.staffAgentId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length];
}

async function assertPhysicalDirectory(directory: string): Promise<void> {
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
		throw new Error("UNSAFE_DESKTOP_STATE_DIRECTORY");
}

/** Hourly frames follow the image name with the two-digit local hour. */
export const COMPANY_COMPUTER_SCREEN_HOURS = Object.freeze(
	Array.from({ length: 24 }, (_value, hour) => String(hour).padStart(2, "0")),
);
const TIME_ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** IANA zone names only; the guest wrapper additionally requires the zone to exist in its image. */
export function isCompanyComputerScreenTimeZone(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && TIME_ZONE.test(value);
}

async function readImage(source: string, signal: AbortSignal): Promise<Buffer> {
	const info = await lstat(source);
	if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024)
		throw new Error("INVALID_SCREEN_WALLPAPER");
	const bytes = await readFile(source, { signal });
	if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) throw new Error("INVALID_SCREEN_WALLPAPER");
	return bytes;
}

async function publish(
	directory: string,
	name: string,
	bytes: Buffer | string,
	before: () => Promise<void>,
	signal: AbortSignal,
): Promise<string> {
	const target = join(directory, name);
	const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal });
		await before();
		signal.throwIfAborted();
		await rename(temporary, target);
		return target;
	} finally {
		await rm(temporary, { force: true });
	}
}

/**
 * Guest-supervisor helper, invoked under its existing serialized registry
 * reconcile before launch (and after an appearance change). Never a model tool.
 * The boundary and caller must hold the exact binding through publication.
 * Reuses explicit read/write + rename, which works across the image/VirtioFS
 * boundary where the historical fs.copyFile syscall failed with EPERM.
 */
export async function prepareCompanyComputerScreenWallpaper(
	options: {
		binding: CompanyComputerScreenBinding;
		layout: CompanyComputerGuestLayout;
		boundary: CompanyComputerGuestBoundary;
		templateId?: string;
		/** Persisted agent appearance takes precedence, matching the current renderer. */
		creature?: string;
		/** Trusted image directory; override only for packaging variants or local fixtures, never model input. */
		imageRoot?: string;
		/** Provider-configured company local zone; the desktop clock, terminal and backdrop cycle follow it. */
		timeZone?: string;
	},
	signal: AbortSignal,
): Promise<{ wallpaper: string; creature: StaffCharacterId; backdrops?: string }> {
	assertCompanyComputerGuestLayout(options.layout);
	if (options.timeZone !== undefined && !isCompanyComputerScreenTimeZone(options.timeZone))
		throw new Error("INVALID_SCREEN_TIME_ZONE");
	const binding = Object.freeze({ ...options.binding });
	const root = options.layout.screenStateRoot;
	const imageRoot = options.imageRoot ?? "/usr/share/backgrounds";
	const creature = companyComputerScreenCreature(binding, options.templateId, options.creature);
	await options.boundary.assertReady(binding, signal);
	signal.throwIfAborted();
	await assertPhysicalDirectory(root);
	await assertPhysicalDirectory(imageRoot);
	const bytes = await readImage(join(imageRoot, `qorpera-screen-${creature}.png`), signal);
	// An image without the full hourly set (or an older image) keeps the static
	// wallpaper; the wrapper refuses partial sets rather than cycling them.
	const frames: Buffer[] = [];
	for (const hour of COMPANY_COMPUTER_SCREEN_HOURS) {
		const source = join(imageRoot, `qorpera-screen-${creature}-${hour}.png`);
		const present = await lstat(source).then(
			(info) => info.isFile() && !info.isSymbolicLink(),
			() => false,
		);
		if (!present) break;
		frames.push(await readImage(source, signal));
	}
	const directory = join(root, binding.screenId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await assertPhysicalDirectory(directory);
	const authority = async () => {
		await options.boundary.assertReady(binding, signal);
	};
	const wallpaper = await publish(directory, "wallpaper.png", bytes, authority, signal);
	if (options.timeZone === undefined) await rm(join(directory, "time-zone"), { force: true });
	else await publish(directory, "time-zone", `${options.timeZone}\n`, authority, signal);
	const backdrops = join(directory, "backdrops");
	if (frames.length !== COMPANY_COMPUTER_SCREEN_HOURS.length) {
		await rm(backdrops, { recursive: true, force: true });
		return { wallpaper, creature };
	}
	await mkdir(backdrops, { recursive: true, mode: 0o700 });
	await assertPhysicalDirectory(backdrops);
	for (const [index, hour] of COMPANY_COMPUTER_SCREEN_HOURS.entries())
		await publish(backdrops, `${hour}.png`, frames[index], authority, signal);
	return { wallpaper, creature, backdrops };
}
