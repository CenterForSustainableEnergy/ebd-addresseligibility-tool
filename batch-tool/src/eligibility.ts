// The same geographic rule as the main backend's /api/overlay
// (backend/src/index.ts), so a batch row and a widget lookup for the same
// address agree. Reason codes match the backend's where both have them.
export type EligibilityInput = {
	tract: string; // 11-digit 2020 GEOID from the overlay; "" when none
	known: boolean; // tract is in tracts.csv
	region: string; // tracts.csv region
	isCfa: boolean; // tracts.csv CFA column is populated
	inDac: boolean;
	inDacBuffer: boolean; // CARB "DAC 1/2 mile neighbor" and not in a DAC
	adjacentCfa: string | null; // CFA whose strip contains the point
};

export function decideEligibility(input: EligibilityInput): {
	eligible: boolean;
	reason: string;
} {
	if (!input.tract) return { eligible: false, reason: "no_tract" };
	if (!input.known) return { eligible: false, reason: "not_in_tract_list" };
	if (input.region !== "Central")
		return { eligible: false, reason: "outside_central" };
	if (input.isCfa && input.inDac) return { eligible: true, reason: "in_dac" };
	if (input.isCfa && input.inDacBuffer)
		return { eligible: true, reason: "dac_buffer" };
	if (!input.isCfa && input.inDacBuffer && input.adjacentCfa)
		return { eligible: true, reason: "cfa_adjacent_dac_buffer" };
	return {
		eligible: false,
		reason: input.isCfa ? "central_not_dac" : "central_not_cfa",
	};
}
