import fs from "node:fs";
import path from "node:path";
import { createObjectCsvWriter } from "csv-writer";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import fetch from "node-fetch";
import Papa from "papaparse";

import XLSX from "xlsx";

// --- Load Building Climate Zones by ZIP Code ---
const climateWorkbook = XLSX.readFile(
	"./data/BuildingClimateZonesByZIPCode_ada.xlsx",
);
const climateSheet = climateWorkbook.Sheets[climateWorkbook.SheetNames[0]];
const climateData = XLSX.utils.sheet_to_json<{
	"Zip Code": string;
	"Building CZ": string;
}>(climateSheet);

// Create a lookup map (ZIP → Building CZ)
const climateZoneByZip = new Map(
	climateData.map((row) => [
		String(row["Zip Code"]).padStart(5, "0"),
		row["Building CZ"],
	]),
);

console.log(`✅ Loaded ${climateZoneByZip.size} ZIP → Climate Zone records.`);

// Load environment
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID!;
const SMARTY_AUTH_TOKEN = process.env.SMARTY_AUTH_TOKEN!;

const app = new Hono();
app.use("*", cors());

// Serve static results (optional)
app.use("/results/*", serveStatic({ root: "./data" }));

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
				const lat = candidate.metadata.latitude;
				const lon = candidate.metadata.longitude;

				// Step 2: ArcGIS overlay
				const arcgisUrl = `https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?longitude=${lon}&latitude=${lat}&returnZ=false&returnM=false&returnTrueCurves=false&returnFeatureCollection=false&returnColumnName=false&simplifyFeatures=true&context=&f=pjson`;
				const arcResp = await fetch(arcgisUrl);
				const arcData = await arcResp.json();

				const value = arcData?.results?.[0]?.value || {};

				// Extract ZIP from Smarty
				const zip = candidate.components?.zipcode || "";

				// Try ArcGIS first, then ZIP-based lookup
				const arcClimateZone = value.CA_climate_zone || "";
				const zipClimateZone = zip ? climateZoneByZip.get(zip) || "" : "";
				const climateZone = arcClimateZone || zipClimateZone || "N/A";

				results.push({
					InputAddress: address,
					StandardizedAddress: `${candidate.delivery_line_1}, ${candidate.last_line}`,
					ZipCode: zip,
					CensusTract: value.GeoID || "",
					AssemblyDistrict: value.AssemblyDist || "",
					SenateDistrict: value.SenateDistrict || "",
					CaliforniaClimateZone: climateZone,
					DisadvantagedCommunity: value.dac || "",
					WithinHalfMileOfADisadvantagedCommunity: value.dac_buffer || "",
					LowIncomeCommunity: value.lic || "",
				});
			} catch (err) {
				console.error("Error processing address:", address, err);
				results.push({ InputAddress: address, Error: "Processing failed" });
			}
		}

		// Step 3: Write results to CSV
		const outputPath = path.join("./data", "batch_results.csv");
		const csvWriter = createObjectCsvWriter({
			path: outputPath,
			header: Object.keys(results[0]).map((key) => ({ id: key, title: key })),
		});
		await csvWriter.writeRecords(results);

		return c.json({
			message: "Batch processing complete",
			count: results.length,
			download: `/results/batch_results.csv`,
		});
	} catch (err) {
		console.error("Batch CSV upload failed:", err);
		return c.json({ error: "Batch processing failed" }, 500);
	}
});

// ------------------------------
// Start server
// ------------------------------
const PORT = process.env.PORT || 3100;
console.log(`📦 Batch lookup tool running at http://localhost:${PORT}`);
export default app;
