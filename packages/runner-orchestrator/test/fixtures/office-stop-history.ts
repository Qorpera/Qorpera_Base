import { createHash } from "node:crypto";
import {
	type CompanyComputerPreparationCommand,
	companyComputerBootDirectory,
	companyComputerStopHistoryDirectory,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";

/** Synthetic archive for unit/Unix HTTP tests only. Real-systemd fixtures
 * must read the actual protected helper's archive instead. */
export function officeStopHistoryFixture(
	files: ReadonlyMap<string, { content: Buffer; mode: number | string }>,
	command: CompanyComputerPreparationCommand,
	activationId: string,
	completionPath: string,
) {
	const root = companyComputerStopHistoryDirectory(command.bootId, activationId),
		hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const bootStartPath = "/run/qorpera-office-preparation/boot-service-start-completion.json",
		boot = files.has(bootStartPath),
		directory = companyComputerBootDirectory(command.bootId),
		start = boot ? JSON.parse(files.get(bootStartPath)!.content.toString()) : undefined;
	const restartPath = `/run/qorpera-office-preparation/boot-service-restart-completion-${activationId}.json`,
		restart =
			boot && activationId !== start.activationId
				? JSON.parse(files.get(restartPath)!.content.toString())
				: undefined;
	const restartPacket = restart
		? JSON.parse(
				files
					.get(
						`/run/qorpera-office-preparation/boot-service-restart-incoming-${restart.command.requestSha256}.json`,
					)!
					.content.toString(),
			)
		: undefined;
	const resetStart = files.get("/run/qorpera-office-preparation/reset-service-start-completion.json");
	const reset = resetStart ? JSON.parse(resetStart.content.toString()) : undefined;
	const resetRestart =
		reset && reset.activationId !== activationId
			? JSON.parse(
					files
						.get(`/run/qorpera-office-preparation/reset-service-restart-completion-${activationId}.json`)!
						.content.toString(),
				)
			: undefined;
	const resetPacket = resetRestart
		? JSON.parse(
				files
					.get(
						`/run/qorpera-office-preparation/reset-service-restart-incoming-${resetRestart.command.requestSha256}.json`,
					)!
					.content.toString(),
			)
		: undefined;
	const resetPaths = reset
		? [
				"/etc/qorpera-office/adoption.json",
				"/run/qorpera-office-preparation/reset-service-start-completion.json",
				"/run/qorpera-office-preparation/reset-service-start-claim.json",
				`/run/qorpera-office-preparation/reset-service-start-incoming-${reset.command.requestSha256}.json`,
				...["reset-configuration-claim.json", "reset-configuration-completion.json", "credentials/config.json"].map(
					(path) => `${directory}/${path}`,
				),
				...(resetRestart
					? [
							`/run/qorpera-office-preparation/reset-service-restart-completion-${activationId}.json`,
							`/run/qorpera-office-preparation/reset-service-restart-incoming-${resetRestart.command.requestSha256}.json`,
							`/run/qorpera-office-preparation/service-successor-${resetPacket.stop.revocation.request.activationId}.json`,
						]
					: []),
			]
		: [];
	const sources = [...files]
		.filter(
			([path]) =>
				(reset
					? resetPaths.includes(path)
					: boot
						? [
								bootStartPath,
								"/run/qorpera-office-preparation/boot-service-start-claim.json",
								`/run/qorpera-office-preparation/boot-service-start-incoming-${start.command.requestSha256}.json`,
								...(restart
									? [
											restartPath,
											`/run/qorpera-office-preparation/boot-service-restart-incoming-${restart.command.requestSha256}.json`,
											`/run/qorpera-office-preparation/service-successor-${restartPacket.stop.revocation.request.activationId}.json`,
										]
									: []),
								...[
									"adoption.json",
									"configuration-claim.json",
									"configuration-completion.json",
									"credentials/config.json",
								].map((name) => `${directory}/${name}`),
							].includes(path)
						: path === "/etc/qorpera-office/credentials/config.json" ||
							path === "/etc/qorpera-office/adoption.json" ||
							path === "/run/qorpera-office-preparation/configuration-completion.json" ||
							path === "/run/qorpera-office-preparation/service-start-completion.json" ||
							path === `/run/qorpera-office-preparation/service-restart-completion-${activationId}.json`) ||
				path === `/run/qorpera-office-preparation/service-stop-incoming-${command.requestSha256}.json` ||
				path === completionPath,
		)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const manifest = parseCompanyComputerStopHistoryManifest(
		{
			schema: "qorpera.office-stop-history/v1",
			command,
			activationId,
			completionPath,
			entries: sources.map(([path, file]) => ({
				path,
				bytes: file.content.length,
				sha256: hash(file.content),
				mode: typeof file.mode === "string" ? Number.parseInt(file.mode, 8) : file.mode,
			})),
		},
		command.bootId,
		activationId,
	);
	const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
	return new Map([
		[`${root}/manifest.json`, bytes],
		[`${root}/claim.json`, Buffer.from(bytes)],
		...sources.map(([, file]): [string, Buffer] => [`${root}/${hash(file.content)}.json`, Buffer.from(file.content)]),
	]);
}
