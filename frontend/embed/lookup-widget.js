(() => {
	// -----------------------------------------
	// Fetch and combine Smarty + ArcGIS results
	// -----------------------------------------
	async function fetchEligibility(address) {
		// Step 1: Address validation (Smarty)
		const respValidate = await fetch("/api/validate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address }),
		});
		const validateData = await respValidate.json();
		if (!validateData.lat || !validateData.lon) return null;

		// Step 2: Spatial overlay (ArcGIS)
		const respOverlay = await fetch("/api/overlay", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				lat: validateData.lat,
				lon: validateData.lon,
				zipcode: validateData.zipcode,
			}),
		});
		const overlayData = await respOverlay.json();

		// Merge both results
		return { ...validateData, ...overlayData };
	}

	// -----------------------------------------
	// Build the widget and attach logic
	// -----------------------------------------
	window.EBDLookup = {
		init: (containerId) => {
			const container = document.getElementById(containerId);
			if (!container) return;

			container.innerHTML = `
				<div class="ebd-lookup">
					<form id="ebdForm" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 400px;">
						<div class="form-group">
							<label for="ebdAddress">Street Address</label>
							<input type="text" id="ebdAddress" placeholder="123 Main Street" required />
						</div>

						<div class="form-group">
							<label for="ebdCity">City</label>
							<input type="text" id="ebdCity" placeholder="San Diego" />
						</div>

						<div class="form-group">
							<label for="ebdZip">ZIP Code</label>
							<input type="text" id="ebdZip" placeholder="90210" required />
						</div>

						<button type="submit" id="ebdSubmit">Search</button>
						</form>
					<div id="ebdResults" style="margin-top: 1rem;"></div>
				</div>
			`;

			const form = container.querySelector("#ebdForm");
			form.addEventListener("submit", async (e) => {
				e.preventDefault();

				const street = container.querySelector("#ebdAddress").value.trim();
				const city = container.querySelector("#ebdCity").value.trim();
				const zip = container.querySelector("#ebdZip").value.trim();

				if (!street || !zip) {
					alert("Please enter both a street address and ZIP code.");
					return;
				}

				const address = `${street}${city ? `, ${city}` : ""}, CA ${zip}`;
				const results = container.querySelector("#ebdResults");
				results.innerHTML = "Searching...";

				try {
					const data = await fetchEligibility(address);

					if (!data) {
						results.innerHTML = "No match found. Please check your address.";
						return;
					}

					let html = `
  <div class="ebd-results" style="margin-top: 1rem; border: 1px solid #ddd; padding: 1rem; border-radius: 0.5rem;">
    <p><strong>Eligibility:</strong> ${data.message || "—"}</p>
  </div>
`;

					// -----------------------------------------
					// Add County Income table if data exists
					// -----------------------------------------
					if (data.county_income?.income_by_household) {
						const income = data.county_income.income_by_household;
						html += `
							<h3 style="margin-top: 1rem;">County Income Verification (${data.county_income.county})</h3>
							<table class="ebd-income-table" style="border-collapse: collapse; width: 100%;">
								<thead>
									<tr style="text-align: left;">
										<th>Household Size</th>
										<th>Maximum Eligible Income</th>
									</tr>
								</thead>
								<tbody>
									${Object.keys(income)
										.map((size) => {
											const val = income[size];
											const displayVal =
												typeof val === "number"
													? `$${val.toLocaleString()}`
													: `$${Number(val).toLocaleString()}`;
											return `<tr><td>${size}</td><td>${displayVal}</td></tr>`;
										})
										.join("")}
								</tbody>
							</table>
						`;
					}

					// -----------------------------------------
					// Add email form if ineligible Central region
					// -----------------------------------------
					if (data.action === "redirect" && data.link) {
						html += `
             <p style="margin-top:1rem;">
               <a href="${data.link}" target="_blank" rel="noopener noreferrer">
                 Visit program site for ${data.region || "your region"}
               </a>
             </p>
           `;
					}

					// 2) Visit-signup (expects backend to include `signup_url`)
					if (data.action === "visit-signup" && data.signup_url) {
						const url = new URL(data.signup_url, window.location.origin);
						if (data.tract) url.searchParams.set("tract", data.tract);
						if (data.zipcode) url.searchParams.set("zip", String(data.zipcode));
						html += `
             <div id="notifySection" style="margin-top: 1.5rem;">
               <p>You're in the Central region but not currently eligible. Join our mailing list to be notified when eligibility expands.</p>
               <p>
                 <a href="${url.toString()}" target="_blank" rel="noopener noreferrer">
                   Join the mailing list
                 </a>
               </p>
             </div>
           `;
					}

					results.innerHTML = html;
				} catch (err) {
					console.error(err);
					results.innerHTML = "Error retrieving results.";
				}
			});
		},
	};
})();
