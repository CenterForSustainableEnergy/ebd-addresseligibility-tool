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

// Bun-specific: import.meta.dir is the directory of this source file.
// Using it (rather than process.cwd()) anchors static-file paths to the
// project layout regardless of which directory the server is started from.
const __dir = (import.meta as unknown as { dir: string }).dir;

// --- Load CFA tract lookup (tract ID → CFA label) ---
const NOT_IN_ICFA = "Not in current ICFA";
const NOT_IN_TRACT_LIST = "Not in Census Tract List. Contact CSE for update.";
const cfaByTract = new Map<string, string>();
// Every tract present in tracts.csv, regardless of whether it has a CFA value.
// Lets us tell "tract is listed but has no CFA" (NOT_IN_ICFA) apart from
// "tract isn't in our list at all" (NOT_IN_TRACT_LIST).
const knownTracts = new Set<string>();

// tracts.csv CFA values carry long descriptions, e.g.
// "Bakersfield (PG&E zonal gas decommissioning area)" or
// "Imperial Valley - Salton Sea, El Centro, Brawley". Reduce to the leading
// place name by trimming at the first "(", ",", ":", or " - " separator.
function shortenCfa(label: string): string {
	const match = label.match(/[(,:]|\s+-\s+/);
	const short = match ? label.slice(0, match.index) : label;
	return short.trim();
}
try {
	const tractPath = path.resolve("./data/tracts.csv");
	if (fs.existsSync(tractPath)) {
		const tractCsv = fs.readFileSync(tractPath, "utf-8");
		const { data } = Papa.parse<{ tract: string; CFA: string }>(tractCsv, {
			header: true,
			skipEmptyLines: true,
		});
		for (const row of data) {
			const tractRaw = String(row.tract ?? "").trim();
			if (!tractRaw) continue;
			// tracts.csv stores tracts without the leading zero (e.g. 6019000600)
			// while ArcGIS GeoID includes it (06019000600); pad to 11 digits so
			// the two formats line up. Mirrors the backend's normalization.
			const tract = tractRaw.padStart(11, "0");
			knownTracts.add(tract);
			const cfa = row.CFA?.trim();
			if (cfa) cfaByTract.set(tract, shortenCfa(cfa));
		}
		console.log(
			`✅ Loaded ${knownTracts.size} tracts (${cfaByTract.size} with CFA).`,
		);
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

const FETCH_TIMEOUT_MS = 20_000;
const MAX_ADDRESS_LENGTH = 500;

const DEFAULT_BATCH_CONCURRENCY = 3;
const BATCH_CONCURRENCY = (() => {
	const raw = process.env.BATCH_CONCURRENCY;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_BATCH_CONCURRENCY;
})();

// Maximum number of batch jobs that may be actively processing at once.
// Additional uploads are rejected with 429 until a slot opens.
const DEFAULT_MAX_ACTIVE_JOBS = 3;
const MAX_ACTIVE_JOBS = (() => {
	const raw = process.env.MAX_ACTIVE_JOBS;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_MAX_ACTIVE_JOBS;
})();

let activeJobCount = 0;

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const JOB_TTL_MS = (() => {
	const raw = process.env.JOB_TTL_MS;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JOB_TTL_MS;
})();

const JOB_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const HALF_MILE_DAC_PREFIX = "dac 1/2 mile neighbor:";

// ArcGIS overlay values can be prefixed with "preview for "; strip that and
// normalize so eligibility checks aren't sensitive to whitespace / casing.
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
	"Potential CFA": string;
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

type LookupErrorStatus = 400 | 404 | 429 | 500;

type LookupResult =
	| { ok: true; data: AddressResult }
	| { ok: false; error: string; status: LookupErrorStatus };

const jobs = new Map<string, BatchJob>();

type ErrorLogEntry = {
	timestamp: string;
	error: string;
	source: "batch" | "single";
	jobId?: string;
};

const MAX_ERROR_LOG = 500;
const errorLog: ErrorLogEntry[] = [];

function recordError(
	error: string,
	source: "batch" | "single",
	jobId?: string,
) {
	errorLog.push({
		timestamp: new Date().toISOString(),
		error,
		source,
		jobId,
	});
	if (errorLog.length > MAX_ERROR_LOG) errorLog.shift();
}

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

async function lookupAddress(
	address: string,
	attempt = 0,
): Promise<LookupResult> {
	try {
		// Step 1: Validate / geocode via Smarty.
		// Try match=enhanced first (accepts non-USPS-deliverable physical locations).
		// Fall back to match=invalid only on a successful 200 with no candidates —
		// this corrects minor misspellings without retrying on rate-limit errors.
		// Note: Smarty's US Street API requires credentials as query parameters;
		// it does not support the Authorization header for this endpoint.
		const smartyUrl = (match: string) =>
			`https://us-street.api.smarty.com/street-address?auth-id=${encodeURIComponent(SMARTY_AUTH_ID)}&auth-token=${encodeURIComponent(SMARTY_AUTH_TOKEN)}&street=${encodeURIComponent(address)}&match=${match}`;
		let smartyResp = await fetch(smartyUrl("enhanced"), {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (smartyResp.status === 429) {
			return {
				ok: false,
				error:
					"Smarty rate limit exceeded — reduce batch size or wait before retrying",
				status: 429,
			};
		}
		if (!smartyResp.ok) {
			return {
				ok: false,
				error: `Smarty error ${smartyResp.status}`,
				status: 500,
			};
		}
		let smartyData = await smartyResp.json();

		if (!smartyData?.length) {
			// Only fall back when enhanced returned 200 with no candidates.
			smartyResp = await fetch(smartyUrl("invalid"), {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (smartyResp.status === 429) {
				return {
					ok: false,
					error:
						"Smarty rate limit exceeded — reduce batch size or wait before retrying",
					status: 429,
				};
			}
			if (!smartyResp.ok) {
				return {
					ok: false,
					error: `Smarty error ${smartyResp.status}`,
					status: 500,
				};
			}
			smartyData = await smartyResp.json();
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
		const arcResp = await fetch(arcgisUrl, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!arcResp.ok) {
			return {
				ok: false,
				error: `ArcGIS error ${arcResp.status}`,
				status: 500,
			};
		}
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

		// Census tract: use the 2020 vintage, which is what tracts.csv is keyed
		// on (and what the backend uses). The overlay also returns GeoID/tract,
		// but those are an older vintage and differ for tracts that were
		// renumbered in the 2020 census (e.g. 06019000600 vs 06019000602).
		const censusTract = String(value.ca_census_tracts_2020 ?? "").trim();

		// --- Potential CFA lookup ---
		// Three cases: tract has a CFA, tract is listed without one
		// (NOT_IN_ICFA), or the tract isn't in tracts.csv at all
		// (NOT_IN_TRACT_LIST). An empty tract means ArcGIS returned none, so
		// keep the existing NOT_IN_ICFA fallback there.
		const paddedTract = censusTract.padStart(11, "0");
		let potentialCfa: string;
		if (censusTract && !knownTracts.has(paddedTract)) {
			potentialCfa = NOT_IN_TRACT_LIST;
		} else {
			potentialCfa = cfaByTract.get(paddedTract) || NOT_IN_ICFA;
		}

		const result: AddressResult = {
			InputAddress: address,
			StandardizedAddress: `${candidate.delivery_line_1}, ${candidate.last_line}`,
			ZipCode: zip,
			County: county,
			CensusTract: censusTract,
			AssemblyDistrict: value.AssemblyDist || "",
			SenateDistrict: value.SenateDistrict || "",
			CaliforniaClimateZone: climateZone,
			DisadvantagedCommunity: value.dac || "",
			LowIncomeCommunity: value.lic || "",
			CARB_PriorityPopulation: carbPriorityClean || "N/A",
			WithinHalfMileOfADisadvantagedCommunity: halfMileDacLabel,
			"Potential CFA": potentialCfa,
		};

		return { ok: true, data: result };
	} catch (err) {
		if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
			if (attempt < 1) {
				// One automatic retry after a short pause — recovers most transient
				// Smarty hangs without masking genuine rate-limit exhaustion.
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 2_000);
				});
				return lookupAddress(address, attempt + 1);
			}
			return {
				ok: false,
				error:
					"Request timed out — try a smaller batch or wait before retrying",
				status: 500,
			};
		}
		// Do not log the address (PII).
		console.error("Address lookup failed:", err);
		return { ok: false, error: "Address lookup failed", status: 500 };
	}
}

class UserError extends Error {}

const ADDRESS_COLUMN_ALIASES: Record<string, string[]> = {
	full: ["address", "full address", "full_address"],
	street: [
		"address:street",
		"street",
		"street address",
		"street_address",
		"address1",
		"address_1",
		"addr",
		"addr1",
	],
	city: ["address:city", "city", "city name", "city_name", "municipality"],
	state: ["address:state", "state", "st", "state code", "state_code"],
	zip: [
		"address:zip",
		"zip",
		"zip code",
		"zip_code",
		"zipcode",
		"postal code",
		"postal_code",
	],
};

type AddressColumnMap = Partial<
	Record<"full" | "street" | "city" | "state" | "zip", string>
>;

function detectAddressColumns(fields: string[]): AddressColumnMap | null {
	const map: AddressColumnMap = {};
	for (const field of fields) {
		const lower = field.toLowerCase().trim();
		for (const [role, aliases] of Object.entries(ADDRESS_COLUMN_ALIASES)) {
			if (aliases.includes(lower)) {
				map[role as keyof AddressColumnMap] = field;
				break;
			}
		}
	}
	if (map.full) return map;
	if (map.street && (map.city || map.state || map.zip)) return map;
	return null;
}

function extractAddress(
	row: Record<string, string | undefined>,
	map: AddressColumnMap,
): string | undefined {
	if (map.full) return row[map.full]?.trim();
	const parts = (["street", "city", "state", "zip"] as const)
		.map((role) => {
			const col = map[role];
			return col ? row[col]?.trim() : undefined;
		})
		.filter(Boolean);
	return parts.length ? parts.join(", ") : undefined;
}

async function processBatchFile(job: BatchJob, file: File) {
	// Phase 1: stream-parse the CSV and collect all valid addresses.
	// PapaParse buffers small files in a single read, so pause/resume inside
	// the step callback does not throttle concurrency — all step() calls fire
	// synchronously before any pause can take effect. Collecting first and
	// processing in a separate phase lets us apply a real semaphore.
	const addresses = await new Promise<string[]>((resolve, reject) => {
		const collected: string[] = [];
		const tooLong: string[] = [];
		let columnMap: AddressColumnMap | undefined;
		let detectionError: string | null = null;

		const readable = Readable as typeof Readable & {
			fromWeb?: (stream: ReadableStream) => Readable;
		};
		const fileStream =
			typeof readable.fromWeb === "function"
				? readable.fromWeb(file.stream())
				: Readable.from(file.stream() as unknown as AsyncIterable<unknown>);

		Papa.parse<Record<string, string>>(fileStream, {
			header: true,
			skipEmptyLines: true,
			step: (row, parser) => {
				if (columnMap === undefined) {
					const fields = row.meta.fields ?? [];
					const detected = detectAddressColumns(fields);
					if (detected === null) {
						detectionError =
							`No recognized address column found. Expected an "address" column, ` +
							`or columns for street and city/state/zip (e.g., "street", "city", "state", "zip"). ` +
							`Found: ${fields.length ? fields.join(", ") : "(no headers)"}`;
						parser.abort();
						return;
					}
					columnMap = detected;
				}
				const address = extractAddress(row.data, columnMap);
				if (address) {
					if (address.length <= MAX_ADDRESS_LENGTH) {
						collected.push(address);
					} else {
						tooLong.push(address);
					}
				}
			},
			complete: () => {
				if (detectionError) {
					reject(new UserError(detectionError));
					return;
				}
				if (tooLong.length) {
					const tooLongError = `Address must be ${MAX_ADDRESS_LENGTH} characters or fewer`;
					job.results.push(
						...tooLong.map((address) => ({
							InputAddress: address,
							Error: tooLongError,
						})),
					);
					job.errors += tooLong.length;
					job.processed += tooLong.length;
				}
				resolve(collected);
			},
			error: (err) => reject(err),
		});
	}).catch((err: unknown) => {
		if (!(err instanceof UserError))
			console.error("Batch CSV parsing failed:", err);
		job.status = "failed";
		job.errorMessage =
			err instanceof UserError
				? (err as UserError).message
				: "CSV parsing failed";
		job.finishedAt = Date.now();
		return null;
	});

	if (addresses === null) return;

	const totalRows = addresses.length + job.processed;
	if (!totalRows) {
		job.status = "failed";
		job.errorMessage = "CSV is empty or invalid format";
		job.finishedAt = Date.now();
		return;
	}

	job.total = totalRows;

	// Phase 2: process with a worker pool so BATCH_CONCURRENCY is enforced
	// without creating one promise per row.
	const maxConcurrent = Math.max(1, BATCH_CONCURRENCY);
	let nextIndex = 0;
	const workerCount = Math.min(maxConcurrent, addresses.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (;;) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= addresses.length) break;
				const address = addresses[index];

				try {
					const lookup = await lookupAddress(address);
					if (lookup.ok === true) {
						job.results.push(lookup.data);
					} else {
						job.errors += 1;
						job.results.push({ InputAddress: address, Error: lookup.error });
						recordError(lookup.error, "batch", job.id);
					}
				} catch (err) {
					// Do not log the address (PII).
					console.error("Error processing an address:", err);
					job.errors += 1;
					job.results.push({ InputAddress: address, Error: "Processing failed" });
					recordError("Processing failed", "batch", job.id);
				} finally {
					job.processed += 1;
				}
			}
		}),
	);

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
		"Potential CFA",
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
	const filePath = path.join(__dir, "..", "public", "index.html");
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

		if (activeJobCount >= MAX_ACTIVE_JOBS) {
			return c.json(
				{ error: "Server busy — too many batches running, try again shortly" },
				429,
			);
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
		activeJobCount += 1;

		void processBatchFile(job, file)
			.catch((err) => {
				console.error("Batch processing failed:", err);
				job.status = "failed";
				job.errorMessage = "Batch processing failed";
				job.finishedAt = Date.now();
			})
			.finally(() => {
				activeJobCount -= 1;
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
		// Relative URL so it resolves under the app's base path (e.g. behind an
		// IIS sub-path reverse proxy). An absolute "/api/..." would hit the site
		// root, which proxies to a different service.
		downloadUrl:
			job.status === "completed" ? `./api/batch-results/${job.id}` : undefined,
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
// GET /api/errors
// ------------------------------
app.get("/api/errors", (c) => {
	const limit = Math.min(Number(c.req.query("limit") ?? 100), MAX_ERROR_LOG);
	const source = c.req.query("source");
	const entries = source
		? errorLog.filter((e) => e.source === source)
		: errorLog;
	return c.json({
		total: entries.length,
		limit,
		errors: entries.slice(-limit).reverse(),
	});
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
		if (address.length > MAX_ADDRESS_LENGTH) {
			return c.json(
				{ error: `Address must be ${MAX_ADDRESS_LENGTH} characters or fewer` },
				400,
			);
		}

		const lookup = await lookupAddress(address);
		if (lookup.ok !== true) {
			recordError(lookup.error, "single");
			return c.json({ error: lookup.error }, lookup.status);
		}

		return c.json(lookup.data);
	} catch (err) {
		console.error("Single address lookup failed:", err);
		recordError("Address lookup failed", "single");
		return c.json({ error: "Address lookup failed" }, 500);
	}
});

// Serve static assets last so API routes always take priority
app.use(
	"*",
	serveStatic({
		root: path.join(__dir, "..", "public"),
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
