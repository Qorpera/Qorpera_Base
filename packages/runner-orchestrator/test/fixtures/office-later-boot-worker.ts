import { companyComputerBootDirectory } from "@qorpera/contracts";
import {
	createOfficeBootActivationWorkerFixture,
	officeBootActivationWorkerFixture,
} from "./office-boot-activation-worker.ts";
import { createOfficeBootConfigurationWorkerFixture } from "./office-boot-configuration-worker.ts";
import { createOfficePowerOffWorkerFixture } from "./office-power-off-worker.ts";
import { createOfficeResumeWorkerFixture } from "./office-resume-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./office-stop-worker.ts";

/** Real provider workers and protected journals; VM/root/SQL responses remain
 * synthetic. Each new activation clears prior volatile guest evidence. */
export async function officeLaterBootWorkerFixture(roots: string[]) {
	const first = await officeBootActivationWorkerFixture(roots);
	await first.run();
	const original = first.configuration.resume.powerOff;
	let activation = first;
	let serial = 1;
	const stop = async () => {
		const directory = companyComputerBootDirectory(activation.state.current!.request.attestation.bootId);
		const stopped = await createOfficeStopWorkerFixture(
			{ ...activation, request: { intentId: first.input.intentId } },
			"reboot",
			`${directory}/credentials/config.json`,
			false,
			id(1000 + serial * 10),
		);
		await stopped.create().reconcile(first.input.intentId, stopped.request, new AbortController().signal);
		return createOfficePowerOffWorkerFixture({ ...original, ...stopped, activation: original.activation });
	};
	const prepareResume = async (power: Awaited<ReturnType<typeof stop>>) => {
		const base = 1000 + serial * 10;
		return createOfficeResumeWorkerFixture(power, {
			bootIntentId: id(base + 1),
			activationId: id(base + 2),
			bootId: id(base + 3),
			operationId: id(base + 4),
		});
	};
	const resume = async (power: Awaited<ReturnType<typeof stop>>) => {
		const resumed = await prepareResume(power);
		await resumed.run();
		const configuration = await createOfficeBootConfigurationWorkerFixture(resumed);
		await configuration.run();
		activation = await createOfficeBootActivationWorkerFixture(configuration);
		await activation.run();
		serial++;
		return { resumed, configuration, activation };
	};
	return { first, original, stop, prepareResume, resume, current: () => activation };
}
