import fs from "node:fs";
import path from "node:path";
import { createObjectCsvWriter } from "csv-writer";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
// import fetch from "node-fetch";
import Papa from "papaparse";

import XLSX from "xlsx";

// --- Load Building Climate Zones by ZIP Code (optional) ---
let climateZoneByZip = new Map<string, string>();
try {
	const climatePath = path.resolve(
		"./data/BuildingClimateZonesByZIPCode_ada.xlsx",
	);
	if (fs.existsSync(climatePath)) {
		const climateWorkbook = XLSX.readFile(climatePath);
		const climateSheet = climateWorkbook.Sheets[climateWorkbook.SheetNames[0]];
		const climateData = XLSX.utils.sheet_to_json<{
			"Zip Code": string;
			"Building CZ": string;
		}>(climateSheet);

		// Create a lookup map (ZIP → Building CZ)
		climateZoneByZip = new Map(
			climateData.map((row) => [
				String(row["Zip Code"]).padStart(5, "0"),
				row["Building CZ"],
			]),
		);

		console.log(
			`✅ Loaded ${climateZoneByZip.size} ZIP → Climate Zone records.`,
		);
	} else {
		console.warn(
			`⚠️ Climate workbook not found at ${climatePath}; ZIP-based climate lookup disabled.`,
		);
	}
} catch (err) {
	console.warn(
		"⚠️ Failed to load climate workbook; continuing without ZIP-based climate lookup.",
		err,
	);
}

// Load environment and validate required credentials
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID;
const SMARTY_AUTH_TOKEN = process.env.SMARTY_AUTH_TOKEN;
if (!SMARTY_AUTH_ID || !SMARTY_AUTH_TOKEN) {
	console.error(
		"Missing SMARTY_AUTH_ID or SMARTY_AUTH_TOKEN environment variables. Exiting.",
	);
	process.exit(1);
}

const app = new Hono();
app.use("*", cors());


// Serve main HTML page at "/"
app.get("/", async (c) => {
	const filePath = path.join(process.cwd(), "public", "index.html");
	const html = await fs.promises.readFile(filePath, "utf8");
	return c.html(html);
});

// Serve all other static assets (JS, CSS, images)
app.use(
	"*",
	serveStatic({
		root: path.join(process.cwd(), "public"),
	}),
);

// ------------------------------
// POST /api/upload-csv
// ------------------------------
app.post("/api/upload-csv", async (c) => {
	try {
		const body = await c.req.parseBody();
		const file = body.file;

		if (!file || !(file instanceof File)) {
			return c.json({ error: "No CSV file uploaded" }, 400);
		}

		// Save uploaded file temporarily
		const uploadPath = path.join("./data", "input.csv");
		const buf = Buffer.from(await file.arrayBuffer());
		fs.writeFileSync(uploadPath, buf);

		const csvContent = fs.readFileSync(uploadPath, "utf8");
		const parsed = Papa.parse<{ address: string }>(csvContent, {
			header: true,
			skipEmptyLines: true,
		});

		if (!parsed.data?.length) {
			return c.json({ error: "CSV is empty or invalid format" }, 400);
		}

		const results: any[] = [];

		for (const row of parsed.data) {
			const address = row.address?.trim();
			if (!address) continue;

			try {
				// Step 1: Validate / geocode via Smarty
				const smartyUrl = `https://us-street.api.smarty.com/street-address?auth-id=${SMARTY_AUTH_ID}&auth-token=${SMARTY_AUTH_TOKEN}&street=${encodeURIComponent(address)}`;
				const smartyResp = await fetch(smartyUrl);
				const smartyData = await smartyResp.json();

				if (!smartyData?.length) {
					results.push({
						InputAddress: address,
						Error: "Address not found",
					});
					continue;
				}

				const candidate = smartyData[0];
				const lat = candidate?.metadata?.latitude;
				const lon = candidate?.metadata?.longitude;

				if (lat == null || lon == null) {
					results.push({
						InputAddress: address,
						Error: "No coordinates returned from Smarty",
					});
					continue;
				}

				// Step 2: ArcGIS overlay
				const arcgisUrl = `https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?longitude=${lon}&latitude=${lat}&returnZ=false&returnM=false&returnTrueCurves=false&returnFeatureCollection=false&returnColumnName=false&simplifyFeatures=true&context=&f=pjson`;
				const arcResp = await fetch(arcgisUrl);
				const arcData = await arcResp.json();

				const value = arcData?.results?.[0]?.value || {};

				// console.log("ArcGIS keys:", Object.keys(value));

				// Extract ZIP from Smarty
				const zip = candidate.components?.zipcode || "";

				// Try ArcGIS first, then ZIP-based lookup
				const arcClimateZone = value.CA_climate_zone || "";
				const zipClimateZone = zip ? climateZoneByZip.get(zip) || "" : "";
				const climateZone = arcClimateZone || zipClimateZone || "N/A";

				// --- Normalize CARB Priority Populations field ---
				const carbPriority = value.carb_priority_pops_4 || "";
				const carbPriorityClean =
					typeof carbPriority === "string" ? carbPriority.trim() : "";

				// --- Determine CARB Eligibility ---
				const ineligibleValues = new Set([
					"low-income community",
					"not a priority population area: low-income households are eligible",
				]);

				const carbNorm = carbPriorityClean.toLowerCase();
				const carbEligible = carbPriorityClean
					? !ineligibleValues.has(carbNorm)
					: false;
				const carbEligibilityLabel = carbPriorityClean
					? carbEligible
						? "Eligible"
						: "Not Eligible"
					: "Unknown";

				// --- Push record ---
				results.push({
					InputAddress: address,
					StandardizedAddress: `${candidate.delivery_line_1}, ${candidate.last_line}`,
					ZipCode: zip,
					CensusTract: value.GeoID || "",
					AssemblyDistrict: value.AssemblyDist || "",
					SenateDistrict: value.SenateDistrict || "",
					CaliforniaClimateZone: climateZone,
					DisadvantagedCommunity: value.dac || "",
					LowIncomeCommunity: value.lic || "",
					CARB_PriorityPopulation: carbPriorityClean || "N/A",
					WithinHalfMileOfADisadvantagedCommunity: carbEligibilityLabel,
				});
			} catch (err) {
				console.error("Error processing address:", address, err);
				results.push({ InputAddress: address, Error: "Processing failed" });
			}
		}

		// Build CSV in memory (no file)
		const csvString = Papa.unparse(results.length ? results : [{ InputAddress: "", Error: "" }]);

		// Return as CSV file directly
		return c.body(csvString, 200, {
		  "Content-Type": "text/csv; charset=utf-8",
		  "Content-Disposition": 'attachment; filename="batch_results.csv"',
		});
	} catch (err) {
		console.error("Batch CSV upload failed:", err);
		return c.json({ error: "Batch processing failed" }, 500);
	}
});


// health check
app.get("/api/health", (c) => {
  return c.json({ ok: true, message: "Batch tool is alive" });
});


// ------------------------------
// Start server
// ------------------------------
const PORT = Number(process.env.PORT) || 3100;

Bun.serve({
	port: PORT,
	fetch: app.fetch,
});

console.log(`📦 Batch lookup tool running at http://localhost:${PORT}`);
