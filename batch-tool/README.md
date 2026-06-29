# EBD Batch Address Eligibility Tool

A standalone companion to the main [EBD Address Eligibility Tool](../README.md) for
looking up **many addresses at once**. Upload a CSV of addresses and download a CSV
of geographic eligibility results (census tract, county, DAC/LIC status, climate
zone, CFA, etc.).

It shares the same data sources as the main backend:

- **[Smarty US Street API](https://www.smarty.com/products/us-street-api)** — address
  validation + geocoding (lat/lon).
- **ArcGIS REST overlay** (`maps3.energycenter.org`) — census tract, county, assembly/
  senate districts, DAC/LIC, CARB priority population, climate zone.
- **`data/tracts.csv`** — census tract → CFA (current ICFA) label.
- **`data/BuildingClimateZonesByZIPCode_ada.xlsx`** (optional) — ZIP → climate zone
  fallback when ArcGIS does not return one.

---

## Setup

Install dependencies (Bun):

```bash
bun install
```

Create a `.env` file in this folder. Contact John Anderson for Smarty key access.

```ini
SMARTY_AUTH_ID=your-smarty-id
SMARTY_AUTH_TOKEN=your-smarty-token
# Corporate security policies often block ports outside 8000–8999.
PORT=8282
```

Optional tuning variables (all have sensible defaults):

| Variable                 | Default     | Purpose                                                    |
| ------------------------ | ----------- | ---------------------------------------------------------- |
| `PORT`                   | `3100`      | HTTP listen port                                           |
| `BATCH_CONCURRENCY`      | `3`         | Max addresses geocoded in parallel per job                 |
| `MAX_ACTIVE_JOBS`        | `3`         | Max concurrent batch jobs; returns 429 when exceeded       |
| `MAX_REQUEST_BODY_SIZE`  | `256 MiB`   | Upload size limit (bytes)                                  |
| `JOB_TTL_MS`             | `1800000`   | How long a finished job's results stay in memory           |

Run:

```bash
bun run src/index.ts
```

The tool serves a small upload UI at `http://localhost:<PORT>/` and the API below.

---

## How it works

1. **Upload** — `POST /api/upload-csv` accepts a CSV with an `address` column. The
   server streams and parses the file, creates an in-memory **job**, and immediately
   returns a `jobId` (HTTP 202). Processing continues in the background.
2. **Geocode + overlay** — each address is geocoded via Smarty, then enriched with the
   ArcGIS overlay and the local CSV/XLSX lookups. Addresses are processed in parallel
   up to `BATCH_CONCURRENCY`.
3. **Poll** — the client polls `GET /api/batch-status/:id` for progress
   (`processed`/`total`/`errors`) until `status` is `completed` or `failed`.
4. **Download** — once complete, `GET /api/batch-results/:id` returns the results CSV.

Jobs are held in memory only and are evicted `JOB_TTL_MS` after they finish, so
results must be downloaded within that window.

### Smarty match strategy

Each address is tried with `match=enhanced` first (which accepts valid physical
locations that aren't USPS-deliverable, e.g. rural addresses). If that returns
nothing, it retries with `match=invalid`, which recovers minor street-name
misspellings at the cost of looser matching.

---

## Input CSV format

The tool accepts two address layouts — single-column or multi-column. Column names are **case-insensitive**.

### Single-column (full address)

Include an `address` column with one complete address per row:

```csv
address
2600 Fresno St Fresno CA 93721
27272 Willowbank Rd Davis CA 95618
```

> **Addresses containing commas must be quoted**, otherwise the comma is treated as a
> column delimiter and only the first segment is read:
>
> ```csv
> address
> "4725 Cebrian Ave, New Cuyama, CA, 93254"
> ```

### Multi-column (street, city, state, zip)

Include separate columns for the address parts. At minimum you need a street column plus at least one of city, state, or zip:

```csv
street,city,state,zip
2600 Fresno St,Fresno,CA,93721
27272 Willowbank Rd,Davis,CA,95618
```

Recognized column name aliases (matching is case-insensitive):

- **Full address:** `address`, `full address`, `full_address`
- **Street:** `street`, `street address`, `street_address`, `address1`, `address_1`, `addr`, `addr1`, `address:street`
- **City:** `city`, `city name`, `city_name`, `municipality`, `address:city`
- **State:** `state`, `st`, `state code`, `state_code`, `address:state`
- **Zip:** `zip`, `zip code`, `zip_code`, `zipcode`, `postal code`, `postal_code`, `address:zip`

If no recognized address column is found the job fails immediately with a message listing the column names that were found.

A sample file is provided at [`data/addresses.csv`](data/addresses.csv).

---

## API reference

| Method & path                | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `POST /api/upload-csv`       | Upload a CSV (`file` form field). Returns `{ jobId }` (202).       |
| `GET  /api/batch-status/:id` | Job progress + `downloadUrl` when complete.                        |
| `GET  /api/batch-results/:id`| Results CSV download (only when job is `completed`).               |
| `POST /api/lookup-single`    | Look up a single address (`{ "address": "..." }`).                 |
| `GET  /api/errors`           | Recent address-lookup failures (see below).                        |
| `GET  /api/health`           | Liveness check.                                                    |

### `GET /api/errors`

Returns an in-memory ring buffer of the most recent address-lookup failures (last
500, newest first). Useful for diagnosing why specific addresses fail without
re-running a batch. The log resets when the server restarts.

Query parameters:

- `limit` — max entries to return (default `100`, capped at 500).
- `source` — filter to `batch` or `single`.

Example:

```bash
curl "http://localhost:8282/api/errors?limit=50&source=batch"
```

```json
{
  "total": 1,
  "limit": 50,
  "errors": [
    {
      "timestamp": "2026-06-05T20:59:01.212Z",
      "address": "ThisIsNotAnAddress",
      "error": "Address not found",
      "source": "batch",
      "jobId": "b66160f9-..."
    }
  ]
}
```

---

## Output columns

`InputAddress`, `StandardizedAddress`, `ZipCode`, `County`, `CensusTract`,
`AssemblyDistrict`, `SenateDistrict`, `CaliforniaClimateZone`,
`DisadvantagedCommunity`, `LowIncomeCommunity`, `CARB_PriorityPopulation`,
`WithinHalfMileOfADisadvantagedCommunity`, `CFA`, `Error`.

Rows that fail populate only `InputAddress` and `Error`; the remaining columns are
blank.

---

This project was created using `bun init` in bun v1.2.22.
[Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
