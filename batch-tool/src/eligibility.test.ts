import { describe, expect, test } from "bun:test";
import { decideEligibility, type EligibilityInput } from "./eligibility";

const base: EligibilityInput = {
	tract: "06029000100",
	known: true,
	region: "Central",
	isCfa: true,
	inDac: false,
	inDacBuffer: false,
	adjacentCfa: null,
};
const decide = (o: Partial<EligibilityInput>) =>
	decideEligibility({ ...base, ...o });

describe("decideEligibility", () => {
	test("CFA tract: DAC or its buffer qualifies", () => {
		expect(decide({ inDac: true })).toEqual({
			eligible: true,
			reason: "in_dac",
		});
		expect(decide({ inDacBuffer: true })).toEqual({
			eligible: true,
			reason: "dac_buffer",
		});
		expect(decide({})).toEqual({ eligible: false, reason: "central_not_dac" });
	});
	test("non-CFA tract qualifies only inside a strip and the buffer", () => {
		const nonCfa = { isCfa: false, inDacBuffer: true };
		expect(decide({ ...nonCfa, adjacentCfa: "Bakersfield" })).toEqual({
			eligible: true,
			reason: "cfa_adjacent_dac_buffer",
		});
		expect(decide({ ...nonCfa })).toEqual({
			eligible: false,
			reason: "central_not_cfa",
		});
		// In a DAC in a bordering tract: not in the buffer, so not eligible.
		expect(
			decide({ isCfa: false, inDac: true, adjacentCfa: "Bakersfield" }),
		).toEqual({ eligible: false, reason: "central_not_cfa" });
	});
	test("outside Central, unknown tract, or no tract is never eligible", () => {
		expect(decide({ region: "Southern", inDac: true }).reason).toBe(
			"outside_central",
		);
		expect(decide({ known: false, inDac: true }).reason).toBe(
			"not_in_tract_list",
		);
		expect(decide({ tract: "", inDac: true }).reason).toBe("no_tract");
	});
});
