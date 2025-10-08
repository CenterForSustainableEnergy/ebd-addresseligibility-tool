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
	// Save notification email
	// -----------------------------------------
	async function sendNotify(email, tract) {
		const resp = await fetch("/api/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, tract }),
		});
		return await resp.json();
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
					<h2>Do You Qualify?</h2>
					<p>Enter your address, city, and ZIP code to check eligibility.</p>
					<form id="ebdForm">
						<label>Street Address</label><br>
						<input type="text" id="ebdAddress" placeholder="123 Main Street" required />
						<label>City</label><br>
						<input type="text" id="ebdCity" placeholder="San Diego" />
						<label>ZIP Code</label><br>
						<input type="text" id="ebdZip" placeholder="90210" required />
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

				const address = `${street}${city ? ", " + city : ""}, CA ${zip}`;
				const results = container.querySelector("#ebdResults");
				results.innerHTML = "Searching...";

				try {
					const data = await fetchEligibility(address);

					if (!data) {
						results.innerHTML = "No match found. Please check your address.";
						return;
					}

					let html = `
						<table class="ebd-results-table" style="border-collapse: collapse; width: 100%; margin-top: 1rem;">
							<thead>
								<tr style="text-align: left;">
									<th>Standardized Address</th>
									<th>Coordinates</th>
									<th>Census Tract</th>
									<th>Eligibility</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>${data.standardized || "—"}</td>
									<td>${data.lat}, ${data.lon}</td>
									<td>${data.tract || "—"}</td>
									<td>${data.message || "—"}</td>
								</tr>
							</tbody>
						</table>
					`;

					// -----------------------------------------
					// Add County Income table if data exists
					// -----------------------------------------
					if (data.county_income && data.county_income.income_by_household) {
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
					if (
						data.action === "collect-email" ||
						(data.region === "Central" && !data.eligible)
					) {
						html += `
							<div id="notifySection" style="margin-top: 1.5rem;">
								<p>You're in the Central region but not currently eligible. Enter your email below and we'll notify you when eligibility expands.</p>
								<form id="notifyForm">
									<label>Email:</label>
									<input type="email" id="notifyEmail" placeholder="name@example.com" required />
									<button type="submit">Notify Me</button>
								</form>
								<div id="notifyMessage" style="margin-top:0.5rem;"></div>
							</div>
						`;
					}

					results.innerHTML = html;

					// -----------------------------------------
					// Handle email submission
					// -----------------------------------------
					const notifyForm = results.querySelector("#notifyForm");
					if (notifyForm) {
						notifyForm.addEventListener("submit", async (e) => {
							e.preventDefault();
							const email = results.querySelector("#notifyEmail").value.trim();
							const msg = results.querySelector("#notifyMessage");

							if (!email) {
								msg.textContent = "Please enter a valid email.";
								return;
							}

							try {
								const resp = await sendNotify(email, data.tract || "");
								if (resp.success) {
									msg.textContent = `✅ Thanks! We'll notify you at ${email}.`;
									notifyForm.reset();
								} else {
									msg.textContent = `⚠️ ${resp.error || "Unable to save email."}`;
								}
							} catch (err) {
								console.error(err);
								msg.textContent =
									"⚠️ Error saving email. Please try again later.";
							}
						});
					}
				} catch (err) {
					console.error(err);
					results.innerHTML = "Error retrieving results.";
				}
			});
		},
	};
})();
