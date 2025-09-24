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
				outputDiv.innerHTML = "No match from backend.";
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

			// Step 3: Display output
			let displayHtml = `
      <strong>Standardized Address:</strong> ${standardized}<br/>
      <strong>Coordinates:</strong> ${lat}, ${lon}<br/>
    `;

			if (overlayData?.success) {
				displayHtml += `
        <strong>Utility:</strong> ${overlayData.utility}<br/>
        <strong>County:</strong> ${overlayData.county}<br/>
        <strong>Tract:</strong> ${overlayData.tract}<br/>
        <strong>DAC:</strong> ${overlayData.dac}<br/>
        <strong>LIC:</strong> ${overlayData.lic}<br/>
      `;
			}

			outputDiv.innerHTML = displayHtml;

			// Debug JSON
			debugPre.textContent = JSON.stringify(
				{ validateData, overlayData },
				null,
				2,
			);
		} catch (err: any) {
			console.error(err);
			outputDiv.innerHTML = "Error: " + err.message;
		}
	});
