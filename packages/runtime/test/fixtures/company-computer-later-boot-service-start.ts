import { bootServiceStartFromConfiguration } from "./company-computer-boot-service-start.ts";
import { laterBootConfigurationFixture } from "./company-computer-later-boot-configuration.ts";

export function bootServiceStartFixture(options: Parameters<typeof laterBootConfigurationFixture>[0] = {}) {
	return bootServiceStartFromConfiguration(laterBootConfigurationFixture(options));
}
