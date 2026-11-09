// CFA-adjacent half-mile DAC strips.
//
// Program rule (2026-11): a home in a Central tract that is NOT a CFA tract is
// still geographically eligible when its tract shares a border with a CFA
// tract, and the home is within half a mile of the DAC part of that CFA tract
// (inside the overlay's "DAC 1/2 mile neighbor" buffer). Only a strip of such a
// tract qualifies, so the strips are precomputed as polygons by
// ebd-surveyanalysis `scripts/build_cfa_adjacent_strips.py` and shipped as
// data/cfa_adjacent_strips.geojson.
//
// The strips are only valid for the CFA list they were built from. The file
// carries a fingerprint of that list; a file whose fingerprint doesn't match
// tracts.csv is refused (no strip eligibility) and logged, so a CFA-list change
// without a strip rebuild fails loudly instead of quietly using stale strips.
//
// This file is duplicated verbatim in backend/src and batch-tool/src.
import { createHash } from "node:crypto";
import fs from "node:fs";

export type TractRow = { tract?: string; region?: string; CFA?: string };

type Ring = [number, number][];
type PolygonCoords = Ring[];

type StripFeature = {
	tract: string;
	cfa: string;
	polygons: PolygonCoords[];
	bbox: [number, number, number, number];
};

export type StripIndex = {
	byTract: Map<string, StripFeature[]>;
	count: number;
};

// sha256 of the sorted `GEOID|region` lines of every CFA tract. ASCII only on
// purpose (CFA labels decode differently under UTF-8 and cp1252). Python twin:
// cfa_fingerprint in build_cfa_adjacent_strips.py.
export function cfaFingerprint(rows: TractRow[]): string {
	const lines = rows
		.filter((r) => (r.CFA ?? "").trim() && (r.tract ?? "").trim())
		.map(
			(r) =>
				`${(r.tract ?? "").trim().padStart(11, "0")}|${(r.region ?? "").trim()}`,
		)
		.sort();
	return createHash("sha256").update(lines.join("\n"), "ascii").digest("hex");
}

function bboxOf(polygons: PolygonCoords[]): [number, number, number, number] {
	let [minX, minY, maxX, maxY] = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	for (const poly of polygons)
		for (const [x, y] of poly[0] ?? []) {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	return [minX, minY, maxX, maxY];
}

function inRing(x: number, y: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i] as [number, number];
		const [xj, yj] = ring[j] as [number, number];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
}

export function inPolygons(
	lon: number,
	lat: number,
	polygons: PolygonCoords[],
): boolean {
	return polygons.some(
		([outer, ...holes]) =>
			!!outer &&
			inRing(lon, lat, outer) &&
			!holes.some((h) => inRing(lon, lat, h)),
	);
}

// biome-ignore lint/suspicious/noExplicitAny: GeoJSON is parsed from a file
export function buildStripIndex(geojson: any, rows: TractRow[]): StripIndex {
	const expected = geojson?.metadata?.cfa_list_sha256;
	const actual = cfaFingerprint(rows);
	if (expected !== actual) {
		throw new Error(
			`strip file was built for a different CFA list (file ${expected}, tracts.csv ${actual}); rebuild it with build_cfa_adjacent_strips.py`,
		);
	}
	const byTract = new Map<string, StripFeature[]>();
	let count = 0;
	for (const f of geojson.features ?? []) {
		const g = f?.geometry;
		const polygons: PolygonCoords[] =
			g?.type === "Polygon"
				? [g.coordinates]
				: g?.type === "MultiPolygon"
					? g.coordinates
					: [];
		const tract = String(f?.properties?.tract ?? "").padStart(11, "0");
		if (!polygons.length || !tract.trim()) continue;
		const feature = {
			tract,
			cfa: String(f.properties.cfa ?? ""),
			polygons,
			bbox: bboxOf(polygons),
		};
		byTract.set(tract, [...(byTract.get(tract) ?? []), feature]);
		count++;
	}
	return { byTract, count };
}

// Load the strip file; null (strip eligibility off) when missing or stale.
export function loadStripIndex(
	filePath: string,
	rows: TractRow[],
): StripIndex | null {
	try {
		if (!fs.existsSync(filePath)) {
			console.error(
				`⚠️ ${filePath} not found; CFA-adjacent strip eligibility is OFF.`,
			);
			return null;
		}
		const index = buildStripIndex(
			JSON.parse(fs.readFileSync(filePath, "utf8")),
			rows,
		);
		console.log(`✅ Loaded ${index.count} CFA-adjacent DAC strips.`);
		return index;
	} catch (err) {
		console.error(
			`⚠️ CFA-adjacent strip eligibility is OFF: ${(err as Error).message}`,
		);
		return null;
	}
}

// The CFA a point's strip borders, or null. `tract` is the 11-digit GEOID the
// overlay returned for the point; the strip must belong to that same tract.
export function stripCfaAt(
	index: StripIndex | null,
	tract: string | null | undefined,
	lon: number,
	lat: number,
): string | null {
	if (!index || !tract || !Number.isFinite(lon) || !Number.isFinite(lat))
		return null;
	for (const f of index.byTract.get(tract.padStart(11, "0")) ?? []) {
		const [minX, minY, maxX, maxY] = f.bbox;
		if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
		if (inPolygons(lon, lat, f.polygons)) return f.cfa;
	}
	return null;
}
