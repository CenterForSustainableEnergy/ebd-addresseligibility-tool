import { Hono } from "hono";

const app = new Hono();

// 🔑 For demo: only using Auth ID
const SMARTY_AUTH_ID = process.env.SMARTY_AUTH_ID;

// -------------------------------
// Endpoint 1: Address Validation (Smarty, demo mode with Auth ID only)
// -------------------------------
app.post("/api/validate", async (c) => {
	try {
		const body = await c.req.json<{ address?: string }>();
		const address = body.address?.trim();

		if (!address) {
			return c.json({ error: "Missing address input" }, 400);
		}

		const url = `https://us-street.api.smarty.com/street-address?auth-id=${SMARTY_AUTH_ID}&street=${encodeURIComponent(address)}`;
		const smartyResp = await fetch(url);
		const smartyData = await smartyResp.json();

		if (!smartyData || smartyData.length === 0) {
			return c.json({ error: "No match found" });
		}

		const candidate = smartyData[0];
		const lat = candidate?.metadata?.latitude;
		const lon = candidate?.metadata?.longitude;
		const standardized = `${candidate.delivery_line_1}, ${candidate.last_line}`;

		return c.json({ standardized, lat, lon, raw: smartyData });
	} catch (err) {
		console.error("Smarty API error:", err);
		return c.json({ error: "Smarty lookup failed" }, 500);
	}
});

// -------------------------------
// Endpoint 2: Spatial Overlay (ArcGIS)
// -------------------------------
app.post("/api/overlay", async (c) => {
	try {
		const body = await c.req.json<{ lat?: number; lon?: number }>();
		const { lat, lon } = body;

		if (!lat || !lon) {
			return c.json({ error: "Missing lat/lon input" }, 400);
		}

		const arcgisUrl = `https://maps3.energycenter.org/arcgis/rest/services/sync/GPServer/LocOverlay_CT/execute?longitude=${lon}&latitude=${lat}&f=pjson`;
		const arcResp = await fetch(arcgisUrl);
		const arcData = await arcResp.json();

		let result: any = {};
		if (arcData?.results?.[0]?.value) {
			result = arcData.results[0].value;
		}

		return c.json({
			success: result.success === "True",
			utility: result.utility || "",
			county: result.county || "",
			tract: result.tract || "",
			dac: result.dac || "",
			lic: result.lic || "",
			raw: arcData,
		});
	} catch (err) {
		console.error("ArcGIS API error:", err);
		return c.json({ error: "ArcGIS overlay failed" }, 500);
	}
});

// -------------------------------
// Start Bun server
// -------------------------------
export default {
	port: process.env.PORT || 3000,
	fetch: app.fetch,
};
