import { describe, expect, test } from "bun:test";
import {
	buildStripIndex,
	cfaFingerprint,
	inPolygons,
	stripCfaAt,
	type TractRow,
} from "./strips";

// Same vector as ebd-surveyanalysis tests/test_build_cfa_adjacent_strips.py.
const ROWS: TractRow[] = [
	{ tract: "6029000100", region: "Central", CFA: "Bakersfield (PG&E) " },
	{ tract: "6065000100", region: "Southern", CFA: "Riverside – I-91 Corridor" },
	{ tract: "6029000200", region: "Central", CFA: "" },
];
const FINGERPRINT =
	"2f170ff89aaa590a55c44dc3f274447243cc7430e639f23da385e9697e3084c1";

// A 1x1 square strip with a 0.2x0.2 hole, in tract 06029000200.
const SQUARE: [number, number][] = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1],
	[0, 0],
];
const HOLE: [number, number][] = [
	[0.4, 0.4],
	[0.6, 0.4],
	[0.6, 0.6],
	[0.4, 0.6],
	[0.4, 0.4],
];
const geojson = (sha: string) => ({
	type: "FeatureCollection",
	metadata: { cfa_list_sha256: sha },
	features: [
		{
			type: "Feature",
			properties: { tract: "06029000200", cfa: "Bakersfield" },
			geometry: { type: "Polygon", coordinates: [SQUARE, HOLE] },
		},
	],
});

describe("cfaFingerprint", () => {
	test("matches the Python build's fingerprint", () => {
		expect(cfaFingerprint(ROWS)).toBe(FINGERPRINT);
	});
	test("ignores CFA label text but not the tract set", () => {
		const relabelled = ROWS.map((r) =>
			r.CFA ? { ...r, CFA: "something else" } : r,
		);
		expect(cfaFingerprint(relabelled)).toBe(FINGERPRINT);
		const added = [
			...ROWS,
			{ tract: "6029000300", region: "Central", CFA: "X" },
		];
		expect(cfaFingerprint(added)).not.toBe(FINGERPRINT);
	});
});

describe("strip lookup", () => {
	const index = buildStripIndex(geojson(FINGERPRINT), ROWS);

	test("a point inside the strip, in the strip's tract, gets its CFA", () => {
		expect(stripCfaAt(index, "06029000200", 0.1, 0.1)).toBe("Bakersfield");
		expect(stripCfaAt(index, "6029000200", 0.9, 0.9)).toBe("Bakersfield");
	});
	test("holes, outside points and other tracts get nothing", () => {
		expect(stripCfaAt(index, "06029000200", 0.5, 0.5)).toBeNull();
		expect(stripCfaAt(index, "06029000200", 1.5, 0.5)).toBeNull();
		expect(stripCfaAt(index, "06029000999", 0.1, 0.1)).toBeNull();
	});
	test("no index or no tract means no strip", () => {
		expect(stripCfaAt(null, "06029000200", 0.1, 0.1)).toBeNull();
		expect(stripCfaAt(index, null, 0.1, 0.1)).toBeNull();
	});
	test("multipolygons", () => {
		const far = SQUARE.map(([x, y]) => [x + 5, y] as [number, number]);
		expect(inPolygons(5.5, 0.5, [[SQUARE], [far]])).toBe(true);
		expect(inPolygons(3, 0.5, [[SQUARE], [far]])).toBe(false);
	});
});

describe("stale strip files are refused", () => {
	test("fingerprint mismatch throws", () => {
		expect(() => buildStripIndex(geojson("not-this-list"), ROWS)).toThrow(
			/different CFA list/,
		);
	});
});
