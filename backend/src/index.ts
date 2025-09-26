import "dotenv/config"
import { Hono } from "hono"
import fs from "fs"
import Papa from "papaparse"

// 🔑 Environment variables
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID
const SMARTY_AUTH_TOKEN = process.env.SMARTY_AUTH_TOKEN

// --- Load Census Tract Data ---
interface TractInfo {
  tract: string
  region: string
  eligible: string // "true"/"false"
}

const tractData: TractInfo[] = Papa.parse<TractInfo>(
  fs.readFileSync("backend/data/tracts.csv", "utf8"),
  { header: true }
).data.map((row) => ({
  ...row,
  tract: row.tract.toString().padStart(11, "0"),
}))


const app = new Hono()

// -------------------------------
// Endpoint 1: Address Validation (Smarty)
// -------------------------------
app.post("/api/validate", async (c) => {
  try {
    const body = await c.req.json<{ address?: string }>()
    const address = body.address?.trim()

    if (!address) {
      return c.json({ error: "Missing address input" }, 400)
    }

    const url =
      `https://us-street.api.smarty.com/street-address?` +
      `auth-id=${SMARTY_AUTH_ID}&auth-token=${SMARTY_AUTH_TOKEN}` +
      `&street=${encodeURIComponent(address)}`

    const smartyResp = await fetch(url)
    const smartyData = await smartyResp.json()

    if (!Array.isArray(smartyData) || smartyData.length === 0) {
      console.error("Smarty API returned:", smartyData)
      return c.json({ error: "No match found", raw: smartyData }, 404)
    }

    const candidate = smartyData[0]
    const lat = candidate?.metadata?.latitude
    const lon = candidate?.metadata?.longitude
    const standardized = `${candidate.delivery_line_1}, ${candidate.last_line}`

    return c.json({ standardized, lat, lon, raw: smartyData })
  } catch (err) {
    console.error("Smarty API error:", err)
    return c.json({ error: "Smarty lookup failed" }, 500)
  }
})

// -------------------------------
// Endpoint 2: Spatial Overlay (ArcGIS + Program Logic)
// -------------------------------
app.post("/api/overlay", async (c) => {
  try {
    const body = await c.req.json<{ lat?: number; lon?: number }>()
    const { lat, lon } = body

    if (!lat || !lon) {
      return c.json({ error: "Missing lat/lon input" }, 400)
    }

    const arcgisUrl =
      `https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?` +
      `longitude=${lon}&latitude=${lat}&f=pjson`

    const arcResp = await fetch(arcgisUrl)
    const arcData = await arcResp.json()

    let result: any = {}
    if (arcData?.results?.[0]?.value) {
      result = arcData.results[0].value
    }

    // Normalize tract to 11-digit string
    const tract = result?.tract?.toString().padStart(11, "0")

    // Also create a display version (drop leading zero if it exists)
    const displayTract = tract?.startsWith("0") ? tract.slice(1) : tract

    const tractInfo = tractData.find((t) => t.tract === tract)

    // --- Program Logic ---
    if (!tractInfo) {
      return c.json({
        success: true,
        eligible: false,
        tract: displayTract,
        message: `Tract ${displayTract} not found in dataset.`,
        region: result?.county || "Unknown",
        action: "redirect",
        link: "https://program-site/general",
      })
    }

    if (tractInfo.region !== "Central") {
      return c.json({
        success: true,
        eligible: false,
        tract: displayTract,
        message: `You are located in the ${tractInfo.region} region.`,
        region: tractInfo.region,
        action: "redirect",
        link: `https://program-site/${tractInfo.region}`,
      })
    }

    if (tractInfo.region === "Central" && tractInfo.eligible === "FALSE") {
      return c.json({
        success: true,
        eligible: false,
        tract: displayTract,
        message: "You are in the Central region but not yet eligible.",
        region: "Central",
        action: "collect-email",
      })
    }

    // Eligible
    return c.json({
      success: true,
      eligible: true,
      tract: displayTract,
      message: "You are in the Central region and eligible!",
      region: "Central",
    })
  } catch (err) {
    console.error("ArcGIS API error:", err)
    return c.json({ error: "ArcGIS overlay failed" }, 500)
  }
})

// -------------------------------
// Endpoint 3: Save Notification Emails
// -------------------------------
app.post("/api/notify", async (c) => {
  try {
    const body = await c.req.json<{ email?: string; tract?: string }>()
    const email = body.email?.trim()
    const tract = body.tract || ""

    if (!email) {
      return c.json({ error: "Missing email" }, 400)
    }

    // Simple email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return c.json({ error: "Invalid email format" }, 400)
    }

    // Append to CSV
    const line = `${new Date().toISOString()},${tract},${email}\n`
    fs.appendFileSync("backend/data/emails.csv", line, "utf8")

    return c.json({ success: true, message: "Email saved for notifications." })
  } catch (err) {
    console.error("Notify API error:", err)
    return c.json({ error: "Failed to save email" }, 500)
  }
})


// -------------------------------
// Optional health check
// -------------------------------
app.get("/", (c) => c.text("Backend is running ✅"))

// -------------------------------
// Start Bun server
// -------------------------------
export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
}
