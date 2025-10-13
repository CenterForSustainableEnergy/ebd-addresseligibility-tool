import "dotenv/config";
import fs from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import Papa from "papaparse";

// -----------------------------------
// Environment Variables
// -----------------------------------
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID;
const SMARTY_AUTH_TOKEN = process.env.SMARTY_AUTH_TOKEN;

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
// Initialize App
// -----------------------------------
const app = new Hono();

// Serve Static Files
app.use("/embed/*", serveStatic({ root: "./frontend/dist" }));
app.use("/*", serveStatic({ root: "./backend/public" }));

// -----------------------------------
// Endpoint 1: Address Validation (Smarty)
// -----------------------------------
app.post("/api/validate", async (c) => {
	try {
		const body = await c.req.json<{ address?: string }>();
		const address = body.address?.trim();

		if (!address) return c.json({ error: "Missing address input" }, 400);

		const url =
			`https://us-street.api.smarty.com/street-address?` +
			`auth-id=${SMARTY_AUTH_ID}&auth-token=${SMARTY_AUTH_TOKEN}` +
			`&street=${encodeURIComponent(address)}`;

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
		const arcData = await arcResp.json();

		let result: any = {};
		if (arcData?.results?.[0]?.value) result = arcData.results[0].value;

		const tract = result?.tract?.toString().padStart(11, "0");
		const displayTract = tract?.startsWith("0") ? tract.slice(1) : tract;
		const tractInfo = tractData.find((t) => t.tract === tract);

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
		if (!tractInfo)
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message: `Tract ${displayTract} not found in dataset.`,
				region: result?.county || "Unknown",
				action: "redirect",
				county_income: countyIncome,
			});

		if (tractInfo.region === "Southern")
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message: `The address you entered is outside the coverage territory for this specific program. Visit www.###.com to check your eligibility.`,
				region: tractInfo.region,
				action: "redirect",
				county_income: countyIncome,
			});

		if (tractInfo.region === "Northern")
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message: `The address you entered is outside the coverage territory for this specific program. Visit www.###.com to check your eligibility.`,
				region: tractInfo.region,
				action: "redirect",
				county_income: countyIncome,
			});

		if (tractInfo.region === "Central" && tractInfo.eligible === "false")
			return c.json({
				success: true,
				eligible: false,
				tract: displayTract,
				message:
					"Looks like your area isn't eligible yet. We're growing! Check back soon or join our mailing list to stay informed as the program expands to your community.",
				region: "Central",
				action: "collect-email",
				county_income: countyIncome,
			});

		// Eligible
		return c.json({
			success: true,
			eligible: true,
			tract: displayTract,
			message:
				"You are in the Central region and are geographically eligible! See below for income eligibilty for your area.",
			region: "Central",
			county_income: countyIncome,
		});
	} catch (err) {
		console.error("ArcGIS API error:", err);
		return c.json({ error: "ArcGIS overlay failed" }, 500);
	}
});

// -----------------------------------
// Endpoint 3: Save Notification Emails
// -----------------------------------
app.post("/api/notify", async (c) => {
	try {
		const body = await c.req.json<{ email?: string; tract?: string }>();
		const email = body.email?.trim();
		const tract = body.tract || "";

		if (!email) return c.json({ error: "Missing email" }, 400);

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email))
			return c.json({ error: "Invalid email format" }, 400);

		const line = `${new Date().toISOString()},${tract},${email}\n`;
		fs.appendFileSync("backend/data/emails.csv", line, "utf8");

		return c.json({ success: true, message: "Email saved for notifications." });
	} catch (err) {
		console.error("Notify API error:", err);
		return c.json({ error: "Failed to save email" }, 500);
	}
});

// -----------------------------------
// Health Check
// -----------------------------------
app.get("/", (c) => c.text("Backend is running ✅"));

// -----------------------------------
// Start Bun Server
// -----------------------------------
export default {
	port: process.env.PORT || 3000,
	fetch: app.fetch,
};
