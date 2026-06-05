import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
// import fetch from "node-fetch";
import Papa from "papaparse";

import XLSX from "xlsx";

// --- Load CFA tract lookup (tract ID → CFA label) ---
const NOT_IN_ICFA = "Not in current ICFA";
const cfaByTract = new Map<string, string>();
try {
	const tractPath = path.resolve("./data/tracts.csv");
	if (fs.existsSync(tractPath)) {
		const tractCsv = fs.readFileSync(tractPath, "utf-8");
		const { data } = Papa.parse<{ tract: string; CFA: string }>(tractCsv, {
			header: true,
			skipEmptyLines: true,
		});
		for (const row of data) {
			const cfa = row.CFA?.trim();
			if (cfa) cfaByTract.set(String(row.tract).trim(), cfa);
		}
		console.log(`✅ Loaded ${cfaByTract.size} tract → CFA records.`);
	} else {
		console.warn(
			`⚠️ tracts.csv not found at ${tractPath}; CFA lookup disabled.`,
		);
	}
} catch (err) {
	console.warn(
		"⚠️ Failed to load tracts.csv; continuing without CFA lookup.",
		err,
	);
}

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

const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024 * 256; // 256 MiB
const MAX_REQUEST_BODY_SIZE = (() => {
	const raw = process.env.MAX_REQUEST_BODY_SIZE;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_MAX_REQUEST_BODY_SIZE;
})();

const DEFAULT_BATCH_CONCURRENCY = 3;
const BATCH_CONCURRENCY = (() => {
	const raw = process.env.BATCH_CONCURRENCY;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_BATCH_CONCURRENCY;
})();

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const JOB_TTL_MS = (() => {
	const raw = process.env.JOB_TTL_MS;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JOB_TTL_MS;
})();

const JOB_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const HALF_MILE_DAC_PREFIX = "dac 1/2 mile neighbor:";

function cleanOverlayLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/^preview\s+for\s+/i, "").trim();
}

function normalizeOverlayLabel(value: unknown): string {
	return cleanOverlayLabel(value).toLowerCase();
}

// ArcGIS reports the 1/2-mile DAC case via the CARB label, but a true DAC hit
// should not also be marked as being in the neighboring buffer.
function getHalfMileDacLabel(
	dacValue: unknown,
	carbPriorityValue: unknown,
): string {
	const dacLabel = normalizeOverlayLabel(dacValue);
	if (dacLabel === "yes" || dacLabel === "true") return "No";

	const carbPriorityLabel = normalizeOverlayLabel(carbPriorityValue);
	if (!carbPriorityLabel) return "Unknown";

	return carbPriorityLabel.startsWith(HALF_MILE_DAC_PREFIX) ? "Yes" : "No";
}

type AddressResult = {
	InputAddress: string;
	StandardizedAddress: string;
	ZipCode: string;
	County: string;
	CensusTract: string;
	AssemblyDistrict: string;
	SenateDistrict: string;
	CaliforniaClimateZone: string;
	DisadvantagedCommunity: string;
	LowIncomeCommunity: string;
	CARB_PriorityPopulation: string;
	WithinHalfMileOfADisadvantagedCommunity: string;
	CFA: string;
};

type BatchRowResult =
	| AddressResult
	| {
			InputAddress: string;
			Error: string;
	  };

type BatchJobStatus = "processing" | "completed" | "failed";

type BatchJob = {
	id: string;
	status: BatchJobStatus;
	createdAt: number;
	finishedAt?: number;
	total: number;
	processed: number;
	errors: number;
	results: BatchRowResult[];
	csv?: string;
	errorMessage?: string;
};

type LookupErrorStatus = 400 | 404 | 500;

type LookupResult =
	| { ok: true; data: AddressResult }
	| { ok: false; error: string; status: LookupErrorStatus };

const jobs = new Map<string, BatchJob>();

setInterval(() => {
	const now = Date.now();
	for (const [id, job] of jobs.entries()) {
		if (job.status === "processing" || !job.finishedAt) continue;
		if (now - job.finishedAt > JOB_TTL_MS) {
			jobs.delete(id);
		}
	}
}, JOB_CLEANUP_INTERVAL_MS);

function getJob(id: string) {
	const job = jobs.get(id);
	if (!job) return undefined;
	if (
		job.status !== "processing" &&
		job.finishedAt &&
		Date.now() - job.finishedAt > JOB_TTL_MS
	) {
		jobs.delete(id);
		return undefined;
	}
	return job;
}

async function lookupAddress(address: string): Promise<LookupResult> {
	try {
		// Step 1: Validate / geocode via Smarty.
		// Try match=enhanced first (accepts non-USPS-deliverable physical locations).
		// Fall back to match=invalid if enhanced returns nothing — this corrects
		// minor street-name misspellings at the cost of accepting looser matches.
		const smartyBase = `https://us-street.api.smarty.com/street-address?auth-id=${SMARTY_AUTH_ID}&auth-token=${SMARTY_AUTH_TOKEN}&street=${encodeURIComponent(address)}`;
		let smartyData = await fetch(`${smartyBase}&match=enhanced`).then((r) =>
			r.json(),
		);

		if (!smartyData?.length) {
			smartyData = await fetch(`${smartyBase}&match=invalid`).then((r) =>
				r.json(),
			);
		}

		if (!smartyData?.length) {
			return { ok: false, error: "Address not found", status: 404 };
		}

		const candidate = smartyData[0];
		const lat = candidate?.metadata?.latitude;
		const lon = candidate?.metadata?.longitude;

		if (lat == null || lon == null) {
			return {
				ok: false,
				error: "No coordinates returned from Smarty",
				status: 400,
			};
		}

		// Step 2: ArcGIS overlay
		const arcgisUrl = `https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?longitude=${lon}&latitude=${lat}&returnZ=false&returnM=false&returnTrueCurves=false&returnFeatureCollection=false&returnColumnName=false&simplifyFeatures=true&context=&f=pjson`;
		const arcResp = await fetch(arcgisUrl);
		const arcData = await arcResp.json();

		const value = arcData?.results?.[0]?.value || {};

		// County (prefer ArcGIS, fallback to Smarty)
		const county =
			(typeof value.county === "string" && value.county.trim()) ||
			(typeof candidate?.metadata?.county_name === "string" &&
				candidate.metadata.county_name.trim()) ||
			"";

		// Extract ZIP from Smarty
		const zip = candidate.components?.zipcode || "";

		// Try ArcGIS first, then ZIP-based lookup
		const arcClimateZone = value.CA_climate_zone || "";
		const zipClimateZone = zip ? climateZoneByZip.get(zip) || "" : "";
		const climateZone = arcClimateZone || zipClimateZone || "N/A";

		// --- Normalize CARB Priority Populations field ---
		const carbPriority = value.carb_priority_pops_4;
		const carbPriorityClean = cleanOverlayLabel(carbPriority);
		const halfMileDacLabel = getHalfMileDacLabel(value.dac, carbPriority);

		const result: AddressResult = {
			InputAddress: address,
			StandardizedAddress: `${candidate.delivery_line_1}, ${candidate.last_line}`,
			ZipCode: zip,
			County: county,
			CensusTract: value.GeoID || "",
			AssemblyDistrict: value.AssemblyDist || "",
			SenateDistrict: value.SenateDistrict || "",
			CaliforniaClimateZone: climateZone,
			DisadvantagedCommunity: value.dac || "",
			LowIncomeCommunity: value.lic || "",
			CARB_PriorityPopulation: carbPriorityClean || "N/A",
			WithinHalfMileOfADisadvantagedCommunity: halfMileDacLabel,
			CFA: cfaByTract.get(value.GeoID) || NOT_IN_ICFA,
		};

		return { ok: true, data: result };
	} catch (err) {
		console.error("Address lookup failed:", address, err);
		return { ok: false, error: "Address lookup failed", status: 500 };
	}
}

async function processBatchFile(job: BatchJob, file: File) {
	const maxConcurrent = Math.max(1, BATCH_CONCURRENCY);
	let pending = 0;
	let parseDone = false;
	let parserPaused = false;
	let parserRef: Papa.Parser | null = null;

	const waitForAll = new Promise<void>((resolve, reject) => {
		const checkDone = () => {
			if (parseDone && pending === 0) resolve();
		};

		const readable = Readable as typeof Readable & {
			fromWeb?: (stream: ReadableStream) => Readable;
		};
		const fileStream =
			typeof readable.fromWeb === "function"
				? readable.fromWeb(file.stream())
				: Readable.from(file.stream() as unknown as AsyncIterable<unknown>);

		Papa.parse<{ address?: string }>(fileStream, {
			header: true,
			skipEmptyLines: true,
			step: (row, parser) => {
				parserRef = parser;
				const address = row.data?.address?.trim();
				if (!address) return;

				job.total += 1;
				pending += 1;
				if (!parserPaused && pending >= maxConcurrent) {
					parser.pause();
					parserPaused = true;
				}

				lookupAddress(address)
					.then((lookup) => {
						if (lookup.ok === true) {
							job.results.push(lookup.data);
						} else {
							job.errors += 1;
							job.results.push({ InputAddress: address, Error: lookup.error });
						}
					})
					.catch((err) => {
						console.error("Error processing address:", address, err);
						job.errors += 1;
						job.results.push({
							InputAddress: address,
							Error: "Processing failed",
						});
					})
					.finally(() => {
						pending -= 1;
						job.processed += 1;

						if (!parseDone && parserPaused && pending < maxConcurrent) {
							parserRef?.resume();
							parserPaused = false;
						}

						checkDone();
					});
			},
			complete: () => {
				parseDone = true;
				checkDone();
			},
			error: (err) => reject(err),
		});
	});

	try {
		await waitForAll;
	} catch (err) {
		console.error("Batch CSV parsing failed:", err);
		job.status = "failed";
		job.errorMessage = "CSV parsing failed";
		job.finishedAt = Date.now();
		return;
	}

	if (!job.total) {
		job.status = "failed";
		job.errorMessage = "CSV is empty or invalid format";
		job.finishedAt = Date.now();
		return;
	}

	const ALL_FIELDS: string[] = [
		"InputAddress",
		"StandardizedAddress",
		"ZipCode",
		"County",
		"CensusTract",
		"AssemblyDistrict",
		"SenateDistrict",
		"CaliforniaClimateZone",
		"DisadvantagedCommunity",
		"LowIncomeCommunity",
		"CARB_PriorityPopulation",
		"WithinHalfMileOfADisadvantagedCommunity",
		"CFA",
		"Error",
	];
	job.csv = Papa.unparse(
		job.results.length ? job.results : [{ InputAddress: "", Error: "" }],
		{ columns: ALL_FIELDS },
	);
	job.results = [];
	job.status = "completed";
	job.finishedAt = Date.now();
}

const app = new Hono();
app.use("*", cors());

// Serve main HTML page at "/"
app.get("/", async (c) => {
	const filePath = path.join(process.cwd(), "public", "index.html");
	const html = await fs.promises.readFile(filePath, "utf8");
	return c.html(html);
});

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

		const jobId = randomUUID();
		const job: BatchJob = {
			id: jobId,
			status: "processing",
			createdAt: Date.now(),
			total: 0,
			processed: 0,
			errors: 0,
			results: [],
		};
		jobs.set(jobId, job);

		void processBatchFile(job, file).catch((err) => {
			console.error("Batch processing failed:", err);
			job.status = "failed";
			job.errorMessage = "Batch processing failed";
			job.finishedAt = Date.now();
		});

		return c.json({ jobId }, 202);
	} catch (err) {
		console.error("Batch CSV upload failed:", err);
		return c.json({ error: "Batch processing failed" }, 500);
	}
});

// ------------------------------
// GET /api/batch-status/:id
// ------------------------------
app.get("/api/batch-status/:id", (c) => {
	const id = c.req.param("id");
	const job = getJob(id);
	if (!job) {
		return c.json({ error: "Batch job not found" }, 404);
	}

	return c.json({
		id: job.id,
		status: job.status,
		total: job.total,
		processed: job.processed,
		errors: job.errors,
		error: job.errorMessage,
		downloadUrl:
			job.status === "completed" ? `/api/batch-results/${job.id}` : undefined,
	});
});

// ------------------------------
// GET /api/batch-results/:id
// ------------------------------
app.get("/api/batch-results/:id", (c) => {
	const id = c.req.param("id");
	const job = getJob(id);
	if (!job) {
		return c.json({ error: "Batch job not found" }, 404);
	}

	if (job.status !== "completed") {
		return c.json({ error: "Batch results not ready" }, 409);
	}

	const csvString =
		job.csv ??
		Papa.unparse(
			job.results.length ? job.results : [{ InputAddress: "", Error: "" }],
		);

	return c.body(csvString, 200, {
		"Content-Type": "text/csv; charset=utf-8",
		"Content-Disposition": 'attachment; filename="batch_results.csv"',
	});
});

// health check
app.get("/api/health", (c) => {
	return c.json({ ok: true, message: "Batch tool is alive" });
});

// ------------------------------
// POST /api/lookup-single
// ------------------------------
app.post("/api/lookup-single", async (c) => {
	try {
		const body = await c.req.json();
		const address = body.address?.trim();

		if (!address) {
			return c.json({ error: "No address provided" }, 400);
		}

		const lookup = await lookupAddress(address);
		if (lookup.ok !== true) {
			return c.json({ error: lookup.error }, lookup.status);
		}

		return c.json(lookup.data);
	} catch (err) {
		console.error("Single address lookup failed:", err);
		return c.json({ error: "Address lookup failed" }, 500);
	}
});

// Serve static assets last so API routes always take priority
app.use(
	"*",
	serveStatic({
		root: path.join(process.cwd(), "public"),
	}),
);

// ------------------------------
// Start server
// ------------------------------
const PORT = Number(process.env.PORT) || 3100;

Bun.serve({
	port: PORT,
	fetch: app.fetch,
	maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
});

console.log(`📦 Batch lookup tool running at http://localhost:${PORT}`);
