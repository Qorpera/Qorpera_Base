import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "./cloud-company-computer-contract.ts";
import {
	assertCompanyComputerGuestLayout,
	type CompanyComputerGuestBoundary,
	type CompanyComputerGuestLayout,
} from "./cloud-company-computer-guest.ts";
import {
	isStaffCharacterId,
	STAFF_CHARACTER_BY_TEMPLATE,
	STAFF_CHARACTER_IDS,
	type StaffCharacterId,
} from "./staff-characters.ts";

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
	},
	signal: AbortSignal,
): Promise<{ wallpaper: string; creature: StaffCharacterId }> {
	assertCompanyComputerGuestLayout(options.layout);
	const binding = Object.freeze({ ...options.binding });
	const root = options.layout.screenStateRoot;
	const imageRoot = options.imageRoot ?? "/usr/share/backgrounds";
	const creature = companyComputerScreenCreature(binding, options.templateId, options.creature);
	await options.boundary.assertReady(binding, signal);
	signal.throwIfAborted();
	await assertPhysicalDirectory(root);
	await assertPhysicalDirectory(imageRoot);
	const source = join(imageRoot, `qorpera-screen-${creature}.png`);
	const info = await lstat(source);
	if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024)
		throw new Error("INVALID_SCREEN_WALLPAPER");
	const bytes = await readFile(source, { signal });
	if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) throw new Error("INVALID_SCREEN_WALLPAPER");
	const directory = join(root, binding.screenId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await assertPhysicalDirectory(directory);
	const wallpaper = join(directory, "wallpaper.png");
	const temporary = join(directory, `.wallpaper-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal });
		await options.boundary.assertReady(binding, signal);
		signal.throwIfAborted();
		await rename(temporary, wallpaper);
		return { wallpaper, creature };
	} finally {
		await rm(temporary, { force: true });
	}
}
