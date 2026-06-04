import "dotenv/config";
import fs from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";
import Papa from "papaparse";

// -----------------------------------
// Environment Variables
// -----------------------------------
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID;
const SMARTY_AUTH_TOKEN = process.env.SMARTY_AUTH_TOKEN;
const SIGNUP_URL =
	process.env.SIGNUP_URL ?? "https://ebd.energycenter.org/#mk-form";

// -----------------------------------
// Load Tract Eligibility Data
// -----------------------------------
interface TractInfo {
	tract: string;
	region: string;
	eligible: string; // "true"/"false"
}

const tractData: TractInfo[] = Papa.parse<TractInfo>(
	fs.readFileSync("backend/data/tracts.csv", "utf8"),
	{ header: true },
).data.map((row) => ({
	...row,
	tract: row.tract.toString().padStart(11, "0"),
}));

// -----------------------------------
// Load County Income Data (ZIP-level)
// -----------------------------------
interface CountyIncome {
	zipcode: string;
	county: string;
	"hhs-income1": string;
	"hhs-income2": string;
	"hhs-income3": string;
	"hhs-income4": string;
	"hhs-income5": string;
	"hhs-income6": string;
	"hhs-income7": string;
	"hhs-income8": string;
}

function cleanIncome(value: string): number {
	if (!value) return 0;
	// Remove $, commas, and spaces before converting
	return Number(value.replace(/[$,\s]/g, "")) || 0;
}

const countyIncomeData: CountyIncome[] = Papa.parse<CountyIncome>(
	fs.readFileSync("backend/data/county_income.csv", "utf8"),
	{ header: true },
).data.map((row) => ({
	...row,
	zipcode: row.zipcode?.trim(),
	county: row.county?.trim(),
	"hhs-income1": cleanIncome(row["hhs-income1"]),
	"hhs-income2": cleanIncome(row["hhs-income2"]),
	"hhs-income3": cleanIncome(row["hhs-income3"]),
	"hhs-income4": cleanIncome(row["hhs-income4"]),
	"hhs-income5": cleanIncome(row["hhs-income5"]),
	"hhs-income6": cleanIncome(row["hhs-income6"]),
	"hhs-income7": cleanIncome(row["hhs-income7"]),
	"hhs-income8": cleanIncome(row["hhs-income8"]),
}));

// -----------------------------------
// ArcGIS Overlay Label Helpers
// -----------------------------------
// ArcGIS overlay values can be prefixed with "preview for "; strip that and
// normalize so eligibility checks aren't sensitive to whitespace / casing.
function cleanOverlayLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/^preview\s+for\s+/i, "").trim();
}

function normalizeOverlayLabel(value: unknown): string {
	return cleanOverlayLabel(value).toLowerCase();
}

const HALF_MILE_DAC_PREFIX = "dac 1/2 mile neighbor:";

function isInDac(dacValue: unknown): boolean {
	const label = normalizeOverlayLabel(dacValue);
	return label === "yes" || label === "true";
}

// ArcGIS reports the 1/2-mile DAC case via the CARB priority label, but a true
// DAC hit should not also be marked as being in the neighboring buffer.
function isInDacHalfMileBuffer(
	dacValue: unknown,
	carbPriorityValue: unknown,
): boolean {
	if (isInDac(dacValue)) return false;
	return normalizeOverlayLabel(carbPriorityValue).startsWith(
		HALF_MILE_DAC_PREFIX,
	);
}

// -----------------------------------
// Initialize App
// -----------------------------------
const app = new Hono();

// -----------------------------------
// CORS setup
// -----------------------------------
const allowedOrigins = new Set<string>([
	"https://ebd.energycenter.org",
	"https://dev-ebd-program.pantheonsite.io",
	"https://test-ebd-program.pantheonsite.io",
	"https://ebd-program.lndo.site",
]);

const corsMiddleware = cors({
	origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : false),
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
	credentials: true,
	maxAge: 600,
});

app.use("/api/*", corsMiddleware);
app.options("/api/*", corsMiddleware);

// -------------------
// Serve Static Files
// -------------------
app.use("/embed/*", serveStatic({ root: "./frontend/dist" }));
app.use("/*", serveStatic({ root: "./backend/public" }));

// -----------------------------------
// Rate Limiter (in-memory)
// -----------------------------------

// Simple limiter: max 5 requests per second per IP address
const limiter = rateLimiter({
	windowMs: 1000, // time window in milliseconds
	limit: 5, // max requests per window per IP
	standardHeaders: true, // adds RateLimit-* headers
	keyGenerator: (c) =>
		c.req.header("x-forwarded-for") ||
		c.req.raw?.connection?.remoteAddress ||
		"unknown",
});

// -----------------------------------
// Endpoint 1: Address Validation (Smarty)
// -----------------------------------
app.post("/api/validate", limiter, async (c) => {
	try {
		const body = await c.req.json<{ address?: string }>();
		const address = body.address?.trim();

		if (!address) return c.json({ error: "Missing address input" }, 400);

		const url =
			`https://us-street.api.smarty.com/street-address?` +
			`auth-id=${SMARTY_AUTH_ID}&auth-token=${SMARTY_AUTH_TOKEN}` +
			`&match=enhanced&street=${encodeURIComponent(address)}`;

		const smartyResp = await fetch(url);
		const smartyData = await smartyResp.json();

		if (!Array.isArray(smartyData) || smartyData.length === 0)
			return c.json({ error: "No match found", raw: smartyData }, 404);

		const candidate = smartyData[0];
		const lat = candidate?.metadata?.latitude;
		const lon = candidate?.metadata?.longitude;
		const standardized = `${candidate.delivery_line_1}, ${candidate.last_line}`;
		const zipcode = candidate?.components?.zipcode;

		return c.json({ standardized, lat, lon, zipcode, raw: smartyData });
	} catch (err) {
		console.error("Smarty API error:", err);
		return c.json({ error: "Smarty lookup failed" }, 500);
	}
});

// -----------------------------------
// Endpoint 2: Spatial Overlay + Logic + Income Data
// -----------------------------------
app.post("/api/overlay", async (c) => {
	try {
		const body = await c.req.json<{
			lat?: number;
			lon?: number;
			zipcode?: string;
		}>();
		const { lat, lon, zipcode } = body;

		if (!lat || !lon) return c.json({ error: "Missing lat/lon input" }, 400);

		const arcgisUrl =
			`https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?` +
			`longitude=${lon}&latitude=${lat}&f=pjson`;

		const arcResp = await fetch(arcgisUrl);
		const arcText = await arcResp.text();

		// ArcGIS sometimes returns HTML with embedded JSON in <pre> tags
		const jsonMatch = arcText.match(/{[\s\S]*}/);
		if (!jsonMatch) {
			console.error("ArcGIS HTML parse error:", arcText.slice(0, 400));
			return c.json({ error: "ArcGIS returned unexpected format" }, 500);
		}

		const arcData = JSON.parse(jsonMatch[0]);
		let result: any = {};
		if (arcData?.results?.[0]?.value) result = arcData.results[0].value;

		// -----------------------------------
		// Census Tract from ca_census_tracts_2020
		// -----------------------------------
		// --- Census tract extraction ---
		const tractRaw = result?.ca_census_tracts_2020;
		const tract = tractRaw ? tractRaw.toString().padStart(11, "0") : null;
		const displayTract =
			tract && tract.startsWith("0") ? tract.slice(1) : tract;
		const tractInfo = tract ? tractData.find((t) => t.tract === tract) : null;

		// -----------------------------------
		// CARB Priority Population Logic (metadata only)
		// -----------------------------------
		const INELIGIBLE_VALUES = new Set<string>([
			"low-income community",
			"not a priority population area: low-income households are eligible",
		]);

		const carbRaw = result?.carb_priority_pops_4 as string | undefined;
		const carbNorm = normalizeOverlayLabel(carbRaw);
		const isPriority = carbNorm.length > 0 && !INELIGIBLE_VALUES.has(carbNorm);

		// -----------------------------------
		// DAC Eligibility Logic
		// -----------------------------------
		// Per program rule: a home qualifies if its census tract is a DAC, or
		// if it sits within 1/2 mile of a DAC tract. The 1/2-mile buffer is
		// reported by ArcGIS via the CARB priority label and is exclusive of
		// the DAC itself (a DAC hit is not also a "neighbor").
		const inDac = isInDac(result?.dac);
		const inDacBuffer = isInDacHalfMileBuffer(
			result?.dac,
			result?.carb_priority_pops_4,
		);
		const geoEligible = inDac || inDacBuffer;
		const dacReason = inDac ? "in_dac" : inDacBuffer ? "dac_buffer" : null;

		// -----------------------------------
		// Lookup County Income Data by ZIP
		// -----------------------------------
		let countyIncome = null;
		if (zipcode) {
			const zipMatch = countyIncomeData.find(
				(row) => row.zipcode === zipcode.toString(),
			);
			if (zipMatch) {
				countyIncome = {
					county: zipMatch.county,
					income_by_household: {
						1: zipMatch["hhs-income1"],
						2: zipMatch["hhs-income2"],
						3: zipMatch["hhs-income3"],
						4: zipMatch["hhs-income4"],
						5: zipMatch["hhs-income5"],
						6: zipMatch["hhs-income6"],
						7: zipMatch["hhs-income7"],
						8: zipMatch["hhs-income8"],
					},
				};
			}
		}

		// -----------------------------------
		// Eligibility Logic
		// -----------------------------------
		// --- Guard: no tract or tract not in California dataset ---
		if (!tract || !tractInfo) {
			return c.json({
				success: false,
				eligible: false,
				tract: displayTract || "N/A",
				message:
					"The address you entered is outside the coverage territory for this program. Please ensure the address is within California and try again.",
				region: "Out of area",
				action: "redirect",
				link: "https://socalebd.org/", // optional redirect for out-of-area users
				carb_priority: { is_priority: false, label: "" },
				county_income: null,
			});
		}

		// Southern region
		if (tractInfo.region === "Southern")
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message:
					"The address you entered is outside the coverage territory for this specific program. Visit https://socalebd.org/ to check your eligibility.",
				region: tractInfo.region,
				action: "redirect",
				carb_priority: { is_priority: isPriority, label: carbRaw || "" },
				county_income: countyIncome,
			});

		// Northern region
		if (tractInfo.region === "Northern")
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message:
					"The address you entered is outside the coverage territory for this specific program. Visit the Northern region EBD website to check your eligibility.",
				region: tractInfo.region,
				action: "redirect",
				carb_priority: { is_priority: isPriority, label: carbRaw || "" },
				county_income: countyIncome,
			});

		// Central region - eligibility is now driven by DAC tract membership or
		// the 1/2-mile DAC buffer, not by the per-tract `eligible` column.
		if (tractInfo.region === "Central" && geoEligible) {
			const message = `
				It appears that your address may be within the eligible area for this program.
				Please review the table below to see if your household income also meets the eligibility requirements.
				<br><br>
				If your income falls below the listed threshold, you can visit the application portal
				to complete the next steps for upgrading your home.
				<br><br>
				<em>Note:</em> Income limits are current as of April 23, 2025 and may change based on
				federal or state guidelines.
				<a href="https://www.hcd.ca.gov/sites/default/files/docs/grants-and-funding/income-limits-2025.pdf"
					target="_blank" rel="noopener noreferrer">Click here</a>
				to learn more about income limits.
`;
			return c.json({
				success: true,
				eligible: true,
				tract: displayTract,
				message,
				region: "Central",
				reason: dacReason, // "in_dac" or "dac_buffer"
				carb_priority: { is_priority: isPriority, label: carbRaw || "" },
				county_income: countyIncome,
			});
		}

		// Central region - in service area, but not in a DAC and not within
		// 1/2 mile of one. Note: this is now an address-level determination, so
		// a neighboring home on the same block may qualify even when this one
		// does not. Avoid promising the area will "grow" into eligibility.
		const notEligibleMessage = `
			This address is within our service area, but it isn't located in a disadvantaged community (DAC)
			or within 1/2 mile of one, so it doesn't currently qualify for this program. Eligibility is
			determined at the address level, so a nearby home may still qualify.
			<a href="${SIGNUP_URL}" target="_blank" rel="noopener noreferrer">Join our mailing list</a>
			to stay informed about future program updates.
		`;
		return c.json({
			success: true,
			eligible: false,
			tract: displayTract,
			message: notEligibleMessage,
			region: "Central",
			reason: "central_not_dac",
			action: "visit-signup",
			signup_url: SIGNUP_URL,
			carb_priority: { is_priority: isPriority, label: carbRaw || "" },
			county_income: countyIncome,
		});
	} catch (err) {
		console.error("ArcGIS API error:", err);
		return c.json({ error: "ArcGIS overlay failed" }, 500);
	}
});

// -----------------------------------
// Health Check
// -----------------------------------
app.get("/", (c) => c.text("Backend is running ✅"));
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// -----------------------------------
// Start Bun Server
// -----------------------------------
export default {
	hostname: "127.0.0.1",
	port: Number(process.env.PORT) || 3000,
	fetch: app.fetch,
};
