import { createHttpCompanyComputerFileImports } from "./cloud-company-computer-file-imports.ts";
import { createHttpCompanyComputerFileExports } from "./cloud-company-computer-file-transfers.ts";
import {
	CompanyComputerLinuxBoundary,
	type CompanyComputerLinuxGuestAttestation,
} from "./cloud-company-computer-linux-boundary.ts";
import {
	CompanyComputerLinuxGuest,
	type CompanyComputerLinuxGuestOptions,
} from "./cloud-company-computer-linux-guest.ts";
import type { CompanyComputerScreenLifecycle } from "./cloud-company-computer-screen-lifecycle.ts";
import {
	createHttpCompanyComputerScreenshots,
	parseCompanyComputerCaptureGateway,
} from "./cloud-company-computer-screenshots.ts";
import { startCompanyComputerOfficeService } from "./cloud-company-computer-service.ts";
import type { CompanyComputerStartupControl } from "./cloud-company-computer-startup.ts";

export type CompanyComputerLinuxOfficeServiceOptions = Omit<
	Parameters<typeof startCompanyComputerOfficeService>[0],
	"guest" | "waitForActivation"
> & {
	startup?: CompanyComputerStartupControl;
	screenLifecycle: CompanyComputerScreenLifecycle;
	/** Protected host configuration. Never mounted into desktop/browser namespaces. */
	captureObjectGateway: { baseUrl: string; token: string; fetch?: typeof fetch };
	linux: Omit<
		CompanyComputerLinuxGuestOptions,
		| "scope"
		| "computerGeneration"
		| "registry"
		| "onFailure"
		| "boundary"
		| "screenshots"
		| "fileExports"
		| "fileImports"
		| "screenLifecycle"
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
	const objectGateway = parseCompanyComputerCaptureGateway(options.captureObjectGateway);
	const stop = new AbortController();
	let failed = false;
	const boundary = new CompanyComputerLinuxBoundary({ ...options.linux, ...options });
	if (options.startup) {
		await options.startup.check(options.signal);
		await boundary.assertPhysicalReady(options.signal);
	} else await boundary.assertOfficeReady(options.signal);
	const guest = new CompanyComputerLinuxGuest({
		...options.linux,
		scope: options.scope,
		computerGeneration: options.computerGeneration,
		registry: options.registry,
		screenLifecycle: options.screenLifecycle,
		boundary,
		fileImports: (run) =>
			createHttpCompanyComputerFileImports({ run, scope: options.scope, registry: options.registry, objectGateway }),
		fileExports: (run) =>
			createHttpCompanyComputerFileExports({ run, scope: options.scope, registry: options.registry, objectGateway }),
		screenshots: (run) =>
			createHttpCompanyComputerScreenshots({
				run,
				scope: options.scope,
				registry: options.registry,
				objectGateway,
			}),
		onFailure: () => {
			failed = true;
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
	const finished = service.finished.then(() => {
		if (failed) throw new Error("OFFICE_LINUX_GUEST_FAILED");
	});
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
