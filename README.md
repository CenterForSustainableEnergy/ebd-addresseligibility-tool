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

## Deployment
### Initial installation
Assuming installation happens on an existing site served by IIS:
1. Build frontend with `bun run build:widget`
2. Copy frontend/dist/\* to desired location in the webserver root
3. Install ARR and URL Rewrite from the Microsooft IIS site, if needed: Under Application Request Routing → Server Proxy Settings, ensure Enable Proxy is checked.
4. Ensure ARR is setup to allow proxy traffic:  
- Open IIS Manager → your site → URL Rewrite → Add Rules → Reverse Proxy.
- Set proxy to: 
```txt
Requested URL: Matches the Pattern
Using: Regular Expressions
Pattern: ^api/(.*)
Action Type: Rewrite
Rewrite URL: http://localhost:3000/api/{R:1}
```
5. Ensure the proxy rule is the first one, and that it's set to stop processing rules after matching.
6. Run the backend as a schedueld task using Task Scheduler:
- Make a logs folder, e.g.,: `D:\ebd-addresseligibility-tool\logs\`
- Open Task Scheduler
- Action (right pane) → Create Task… (not “Basic Task”)
- General tab
	- Name: EBD Backend
	- Security options:
	- Select an account that has access to D:\ebd-addresseligibility-tool (yours is fine).
	- Run whether user is logged on or not ✅
	- Run with highest privileges ✅
	- Configure for: your Windows version.
- Triggers tab
	- New…
		- Begin the task: At startup
		- Delay task for: (optional) 30 seconds
		- Enabled ✅
	- (Optional) Add a second trigger: At log on → for “Any user”.
- Actions tab
- New…
	- Action: Start a program
	- Program/script: C:\Windows\System32\cmd.exe
	- Add arguments: `/c ""C:\Users\John.Anderson\.bun\bin\bun.exe" run backend/src/index.ts >> "D:\ebd-addresseligibility-tool\logs\backend.out.log" 2>&1"`
	- Start in: D:\ebd-addresseligibility-tool
- Conditions tab
	- Uncheck Start the task only if the computer is on AC power (server scenarios often always on AC).
	- Uncheck Stop if the computer switches to battery.
- Settings tab
	- Allow task to be run on demand ✅
	- If the task fails, restart every: 1 minute, Attempt to restart up to: 3 times ✅
	- If the task is already running, then the following rule applies: Do not start a new instance ✅
	- Stop the task if it runs longer than: Uncheck (you want it to run indefinitely)
	- Click OK → you’ll be prompted for credentials → enter them.
7. If needed, add domains to allowed list in backend/src/index.ts
8. If needed, check CORS working by running the following on a different computer (not the webserver):  
```powershell
$h = @{
>>   "Origin" = "https://domain.to-test.org"
>>   "Access-Control-Request-Method" = "POST"
>> }
Invoke-WebRequest "https://maps3.energycenter.org/api/validate" -Method OPTIONS -Headers $h
```
9. Test working

### Modification procedure
If modifications are needed, you may need to force quite the currently running process. It doesn't always accept End commands from Task Scheduler. Remember there are two services running. The backend service is listening on Port 3000, the batch-tool service on Port 3001
1. Check to see if a previously started process is listening on port 3000 or 3001: 
```powershell
netstat -ano | findstr :3000
netstat -ano | findstr :3001
```
2. Force quit the running process:
```powershell
Stop-Process -Id <PID_FROM_ABOVE> -Force
Stop-Process -Id <PID_FROM_ABOVE> -Force
```
3. Make changes by pulling repo branches or similar. If necessary, rebuilding using `bun run build:widget` or similar.
4. Restart the service from the Task Scheduler GUI or with
```powershell
schtasks /Run /TN "EBD Address Tool backend"
schtasks /Run /TN "EBD Address Batch Tool"
```
5. If modified, copy html into relevant inetpub folder.

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
