document
	.getElementById("addressForm")
	?.addEventListener("submit", async (e) => {
		e.preventDefault();

		const addressInput = document.getElementById("address") as HTMLInputElement;
		const outputDiv = document.getElementById("output")!;
		const debugPre = document.getElementById("debug")!;

		const address = addressInput.value.trim();
		outputDiv.innerHTML = "Processing...";
		debugPre.textContent = "";

		try {
			// Step 1: Call backend validate endpoint
			const validateResp = await fetch("/api/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ address }),
			});
			const validateData = await validateResp.json();

			if (!validateData?.lat || !validateData?.lon) {
				outputDiv.innerHTML = "No match found. Please check your address.";
				return;
			}

			const { standardized, lat, lon } = validateData;

			// Step 2: Call backend overlay endpoint
			const overlayResp = await fetch("/api/overlay", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ lat, lon }),
			});
			const overlayData = await overlayResp.json();

			// Step 3: Display results
			let displayHtml = `
      <strong>Standardized Address:</strong> ${standardized}<br/>
      <strong>Coordinates:</strong> ${lat}, ${lon}<br/>
	    <strong>Census Tract:</strong> ${overlayData.tract}<br/>

    `;

			// Handle program logic responses
			if (overlayData.eligible) {
				displayHtml += `<p>✅ ${overlayData.message}</p>`;
			} else {
				displayHtml += `<p>❌ ${overlayData.message}</p>`;

				if (overlayData.action === "redirect") {
					displayHtml += `<p><a href="${overlayData.link}" target="_blank">Visit program site for ${overlayData.region}</a></p>`;
				}

				if (overlayData.action === "collect-email") {
					displayHtml += `
          <form id="notifyForm">
            <label>Email to be notified: <input type="email" id="notifyEmail" required /></label>
            <button type="submit">Notify Me</button>
          </form>
        `;
				}
			}

			outputDiv.innerHTML = displayHtml;

			// Debug JSON
			debugPre.textContent = JSON.stringify(
				{ validateData, overlayData },
				null,
				2,
			);

			// Attach handler for notify form (if shown)
			const notifyForm = document.getElementById("notifyForm");
			if (notifyForm) {
				// Attach handler for notify form (if shown)
				const notifyForm = document.getElementById("notifyForm");
				if (notifyForm) {
					notifyForm.addEventListener("submit", async (e) => {
						e.preventDefault();
						const emailInput = document.getElementById(
							"notifyEmail",
						) as HTMLInputElement;

						try {
							const resp = await fetch("/api/notify", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									email: emailInput.value,
									tract: overlayData?.tract || "", // pass tract if available
								}),
							});
							const data = await resp.json();
							if (data.success) {
								alert(
									`✅ Thanks! We'll notify you at ${emailInput.value} when eligibility changes.`,
								);
							} else {
								alert(`⚠️ Error: ${data.error}`);
							}
						} catch (err: any) {
							alert(`⚠️ Failed to save email: ${err.message}`);
						}
					});
				}
			}
		} catch (err: any) {
			console.error(err);
			outputDiv.innerHTML = "Error: " + err.message;
		}
	});
