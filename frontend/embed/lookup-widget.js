(() => {
	async function fetchEligibility(address) {
		const respValidate = await fetch("/api/validate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address }),
		});
		const validateData = await respValidate.json();
		if (!validateData.lat || !validateData.lon) return null;

		const respOverlay = await fetch("/api/overlay", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lat: validateData.lat, lon: validateData.lon }),
		});
		return await respOverlay.json();
	}

	window.EBDLookup = {
		init: (containerId) => {
			const container = document.getElementById(containerId);
			if (!container) return;

			container.innerHTML = `
        <div class="ebd-lookup">
          <h2>Do You Qualify?</h2>
          <p>Enter your full address and ZIP code to check eligibility.</p>
          <form id="ebdForm">
            <label>Street Address</label><br>
            <input type="text" id="ebdAddress" placeholder="123 Main Street" required />
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
				const address = `${container.querySelector("#ebdAddress").value} ${container.querySelector("#ebdZip").value}`;
				const results = container.querySelector("#ebdResults");
				results.innerHTML = "Searching...";

				try {
					const data = await fetchEligibility(address);
					if (!data) {
						results.innerHTML = "No match found.";
						return;
					}
					results.innerHTML = `
            <table class="ebd-results-table">
              <thead>
                <tr>
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
				} catch (err) {
					console.error(err);
					results.innerHTML = "Error retrieving results.";
				}
			});
		},
	};
})();
