export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.QORPERA_EXPERIMENTAL === "1";
}
