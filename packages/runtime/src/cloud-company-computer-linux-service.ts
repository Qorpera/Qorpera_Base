import { CompanyComputerCommandFolders } from "./cloud-company-computer-command-folder.ts";
import { CompanyComputerDesktopFolders } from "./cloud-company-computer-desktop-folder.ts";
import {
	CompanyComputerLinuxBoundary,
	type CompanyComputerLinuxGuestAttestation,
} from "./cloud-company-computer-linux-boundary.ts";
import {
	CompanyComputerLinuxGuest,
	type CompanyComputerLinuxGuestOptions,
} from "./cloud-company-computer-linux-guest.ts";
import type { CompanyComputerScreenLifecycle } from "./cloud-company-computer-screen-lifecycle.ts";
import { CloudCompanyComputerScreenshots } from "./cloud-company-computer-screenshots.ts";
import { startCompanyComputerOfficeService } from "./cloud-company-computer-service.ts";
import type { CompanyComputerStartupControl } from "./cloud-company-computer-startup.ts";

export type CompanyComputerLinuxOfficeServiceOptions = Omit<
	Parameters<typeof startCompanyComputerOfficeService>[0],
	"guest" | "waitForActivation"
> & {
	startup?: CompanyComputerStartupControl;
	screenLifecycle: CompanyComputerScreenLifecycle;
	/**
	 * The folder helper of an image that has one: each desktop and each shell command then gets the company folder at
	 * `/company` (F3 4d).
	 */
	folderHelper?: { socket: string };
	linux: Omit<
		CompanyComputerLinuxGuestOptions,
		| "scope"
		| "computerGeneration"
		| "registry"
		| "onFailure"
		| "boundary"
		| "screenshots"
		| "screenLifecycle"
		| "folders"
		| "commandFolders"
	> & {
		attestation: CompanyComputerLinuxGuestAttestation;
	};
};

/** The Linux entrypoint supplies adopted mounts, physical identity and asset
 * publication. One failure lifetime then owns the guest and both listeners;
 * an idle browser/display failure cannot leave the office accepting work. */
export async function startCompanyComputerLinuxOfficeService(
	options: CompanyComputerLinuxOfficeServiceOptions,
): ReturnType<typeof startCompanyComputerOfficeService> {
	if (!options.screenLifecycle || typeof options.screenLifecycle.create !== "function")
		throw new Error("OFFICE_SCREEN_LIFECYCLE_REQUIRED");
	const stop = new AbortController();
	let failed = false;
	let failure: unknown;
	const boundary = new CompanyComputerLinuxBoundary({ ...options.linux, ...options });
	if (options.startup) {
		await options.startup.check(options.signal);
		await boundary.assertPhysicalReady(options.signal);
	} else await boundary.assertOfficeReady(options.signal);
	const folders = options.folderHelper
		? new CompanyComputerDesktopFolders({ registry: options.registry, socket: options.folderHelper.socket })
		: undefined;
	// Mounts an earlier activation left belong to ended views. One that does not go now stays the helper's; the first
	// holder of its screen finds it (`held`) and moves it to its own view.
	await folders?.dropLeftovers(options.signal);
	const commandFolders = options.folderHelper
		? new CompanyComputerCommandFolders({ registry: options.registry, socket: options.folderHelper.socket })
		: undefined;
	const guest = new CompanyComputerLinuxGuest({
		...options.linux,
		scope: options.scope,
		computerGeneration: options.computerGeneration,
		registry: options.registry,
		screenLifecycle: options.screenLifecycle,
		...(folders ? { folders } : {}),
		...(commandFolders ? { commandFolders } : {}),
		boundary,
		// No file import or export: those moved bytes through company objects, which are gone (legacy removal, step C).
		screenshots: (run) =>
			new CloudCompanyComputerScreenshots({
				run,
				scope: options.scope,
				registry: options.registry,
			}),
		onFailure: (error) => {
			failed = true;
			failure ??= error;
			stop.abort();
		},
	});
	// The office service owns cleanup even if startup/reconciliation rejects.
	const service = await startCompanyComputerOfficeService({
		...options,
		guest,
		signal: AbortSignal.any([options.signal, stop.signal]),
		...(options.startup
			? {
					waitForActivation: async (
						listeners: { nativePort: number; viewerPort: number },
						signal: AbortSignal,
					) => {
						await options.startup!.waitForActivation(
							listeners,
							(checked) => boundary.assertPhysicalReady(checked),
							signal,
						);
						await boundary.assertOfficeReady(signal);
					},
				}
			: {}),
	});
	const finished = service.finished.then(
		() => {
			if (failed) throw new Error("OFFICE_LINUX_GUEST_FAILED", { cause: failure });
		},
		(error) => {
			if (failed)
				throw new Error(error instanceof Error ? error.message : "OFFICE_LINUX_GUEST_FAILED", {
					cause: new AggregateError([new Error("OFFICE_LINUX_GUEST_FAILED", { cause: failure }), error]),
				});
			throw error;
		},
	);
	void finished.catch(() => undefined);
	if (failed) {
		await service.close();
		await finished;
	}
	return {
		nativePort: service.nativePort,
		viewerPort: service.viewerPort,
		finished,
		close: async () => {
			await service.close();
			await finished;
		},
	};
}
