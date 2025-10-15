# Equitable Building Decarbonization (EBD) – Address Eligibility Lookup Tool

This project provides a **web-based address lookup and eligibility verification tool** for the Equitable Building Decarbonization (EBD) program.

The tool validates user-provided addresses, determines their census tract and region, checks program eligibility, and displays **county-level income thresholds** by household size.  
It can be embedded directly into the EBD program website via a single `<script>` tag.

---

## 🌟 Features

- **Address validation + geocoding**  
  → via [Smarty US Street API](https://www.smarty.com/products/us-street-api).

- **Spatial overlay**  
  → via ArcGIS REST service for census tract and region lookup.
  → See https://github.com/CenterForSustainableEnergy/geocodeidentify for additional details.

- **Program logic**
  - Maps **census tract → region + geographic eligibility** using local CSV (`tracts.csv`).
  - If outside the Central region → displays region + redirect link.
  - If inside Central but ineligible → shows email collection form for future updates.
  - If eligible → confirms geographic eligibility and directs to income eligibility table.

- **County income verification**  
  - Uses `county_income.csv` to show **maximum eligible income** for household sizes 1–8 by ZIP code.

- **Frontend**
  - Built using **Vite + TypeScript (vanilla template)**.
  - Exports an embeddable widget (`lookup-widget.min.js`).

- **Backend**
  - Built using **Hono + Bun**.
  - Handles API requests to Smarty, ArcGIS, and local CSV lookups.

- **Developer tooling**
  - **Biome** for linting/formatting.
  - **Husky** for pre-commit hooks (runs Biome automatically).
  - **Concurrently** for parallel dev mode.

---

## 🚀 Getting Started (Developers)

### 1. Clone the Repository

```bash
git clone https://github.com/CenterForSustainableEnergy/ebd-addresseligibility-tool.git
cd ebd-addresseligibility-tool
```

### 2. To install dependencies:

Install bun (for windows). More details at https://bun.com/docs/installation.

```bash
powershell -c "irm bun.sh/install.ps1|iex"
```

OR (if node is available)

```bash
npm install -g bun
```

These should be installed at the project root. 

```bash
bun install
bun add -d vite
```

### 3. Environmental Variables
Create a new .env file at repo root. Contact John Anderson for Smarty Key access. 

```ini
SMARTY_AUTH_ID=your-smarty-id
SMARTY_AUTH_TOKEN=your-smarty-token
PORT=3000
```
.env is ignored by Git — do not commit it.

### 4. Build the Widget

```bash
bun run build:widget
```
Output file:
frontend/dist/embed/lookup-widget.min.js

### 5. Run the Backend

```bash
bun run backend/src/index.ts
```
Backend starts on http://localhost:3000.

### 6. Test the Tool Locally

```bash
http://localhost:3000/test.html
```

You should see:

* Address, City, ZIP inputs

* Search button

* Results table (geographic eligibility)

* County income eligibility verification table

* Email capture form (for ineligible Central-region users)


## Embedding the Widget on a Website

Add this snippet to any webpage:

```html
<!-- EBD Lookup Tool -->
<script src="https://yourdomain.org/embed/lookup-widget.min.js"></script>
<div id="EBDLookupContainer"></div>
<script>
  EBDLookup.init("EBDLookupContainer");
</script>
```

The widget automatically:
* Renders the input form and results table.
* Calls your backend APIs for validation and overlay.
* Adopts your site’s CSS styling.


Developer Workflow

Lint/format check:

```bash
bun run biome check .
```

Auto-fix:

```bash
bun run biome check --write .
```

Git hooks: Husky runs Biome automatically before each commit.

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
