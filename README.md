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
  → See <https://github.com/CenterForSustainableEnergy/geocodeidentify> for additional details.

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

## 🚀 Getting Started

### 1. Clone the Repository

 ```bash
 git clone https://github.com/CenterForSustainableEnergy/ebd-addresseligibility-tool.git
 cd ebd-addresseligibility-tool
 ```

### 2. Install the IIS dependencies

#### URL Rewrite

1. Download the latest x64 version from IIS.net: [https://www.iis.net/downloads/microsoft/url-rewrite](https://www.iis.net/downloads/microsoft/url-rewrite)
2. Run .msi file to install
3. Restart IIS from powershell with `iisreset`

#### Application Request Routing

> [!Warning]
> Ensure URL Rewrite is installed first. Application Request Routing depends on it.

1. Download the latest x64 version from IIS.net: [https://www.iis.net/downloads/microsoft/application-request-routing](https://www.iis.net/downloads/microsoft/application-request-routing)
2. Run .msi file to install
3. Restart IIS from powershell with `iisreset`
4. Under Application Request Routing → Server Proxy Settings, ensure Enable Proxy is checked.

### 3. Install tool dependencies

Install bun (for Windows) using `irm` (preferred to node to avoid dependency cascade). More details at <https://bun.com/docs/installation>.

 ```bash
 powershell -c "irm bun.sh/install.ps1|iex"
 ```

OR (if node is required)

 ```bash
 npm install -g bun
 ```

These should be installed at both the project root and in the batch-tool folders. This allows bun to pick up all dependencies for both tools.

 ```bash
 bun install
 bun add -d vite
 ```

### 4. Configure environmental variables

Create a new `.env` file at repo root and in `batch-tool\`. Contact John Anderson for Smarty Key access.

 ```ini
 SMARTY_AUTH_ID=your-smarty-id
 SMARTY_AUTH_TOKEN=your-smarty-token
 PORT=3000
 ```

`.env` is ignored by Git via the `.gitignore` file in this repo. Do not commit `.env` files.

### 5. Build the Frontend Widget

For the front end:

 ```bash
 cd D:\ebd-addresseligibility-tool
 bun run build:widget
 ```

Copy `frontend/dist/*` to desired location in the webserver root

### 6. Run the Backend

 ```bash
 cd D:\ebd-addresseligibility-tool
 bun run backend/src/index.ts
 ```

or

 ```bash
 cd D:\ebd-addresseligibility-tool\batch-tool
 bun run src/index.ts
 ```

Backend starts on `http://localhost:3000`. Batch-tool starts on `http://localhost:3001`.

> **Note:** The batch-tool port is configurable via `PORT` in `batch-tool/.env` and can differ per environment. The deployment server uses `3001`; some dev machines use `8282` (corporate security policies may block ports outside 8000–8999). If no `PORT` is set, the code falls back to `3100`. Make sure the batch-tool IIS `web.config` reverse-proxy target matches whatever port that environment runs on.

### 7. Test the Tool Locally

```bash
http://localhost:3000/test.html
```

You should see:

- Address, City, ZIP inputs
- Search button
- Results table (geographic eligibility)
- County income eligibility verification table
- Email capture form (for ineligible Central-region users)

### 8. Configure API

#### Frontend

1. Open `C:\inetpub\wwwroot` and create a text file called `web.config`
2. Paste the following into `web.config`

 ```xml
 <?xml version="1.0" encoding="UTF-8"?>
 <configuration>
 <system.webServer>
  <httpRedirect enabled="false" destination="https://energycenter.org" exactDestination="true" childOnly="true" httpResponseStatus="Permanent" />
  <rewrite>
   <rules>
    <rule name="ReverseProxyInboundRule1" enabled="true" stopProcessing="true">
     <match url="^api/(.*)$" />
     <action type="Rewrite" url="http://localhost:3000/api/{R:1}" />
    </rule>
   </rules>
  </rewrite>
 </system.webServer>
 <location path="iisstart.htm">
  <system.webServer>
   <httpRedirect enabled="true" />
  </system.webServer>
 </location>
 </configuration>

 ```

#### Batch tool

1. Open `C:\inetpub\wwwroot\ebd-address-tool\batch` and create a text file called `web.config`
2. Paste the following into `web.config`

 ```xml
 <?xml version="1.0" encoding="UTF-8"?>
 <configuration>
  <system.webServer>
   <rewrite>
    <rules>
     <clear />
     <rule name="BatchAPIReverseProxy" stopProcessing="true">
      <match url="^api/(.*)$" />
      <conditions logicalGrouping="MatchAll" trackAllCaptures="false" />
      <action type="Rewrite" url="http://localhost:3001/api/{R:1}" />
     </rule>
    </rules>
   </rewrite>
  </system.webServer>
 </configuration>
 ```

Restart IIS from powershell with `iisreset`

### 9. Run the backend as a scheduled task using Task Scheduler

- Make a logs folder, e.g.,: `D:\ebd-addresseligibility-tool\logs\`
- Open Task Scheduler
- Action (right pane) → Create Task… (not “Basic Task”)
- General tab
  - Name: EBD Address Tool backend
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
  - Add arguments: `/c ""C:\Users\John.Anderson\.bun\bin\bun.exe" run backend\src\index.ts >> "D:\ebd-addresseligibility-tool\logs\backend.out.log" 2>&1"`
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

- Action (right pane) → Create Task… (not “Basic Task”)
- General tab
  - Name: EBD Address Batch Tool
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
  - Add arguments: `/c ""C:\Users\John.Anderson\.bun\bin\bun.exe" run src\index.ts >> "D:\ebd-addresseligibility-tool\logs\batch-backend.out.log" 2>&1"`
  - Start in: `D:\ebd-addresseligibility-tool\batch-tool`
- Conditions tab
  - Uncheck Start the task only if the computer is on AC power (server scenarios often always on AC).
  - Uncheck Stop if the computer switches to battery.
- Settings tab
  - Allow task to be run on demand ✅
  - If the task fails, restart every: 1 minute, Attempt to restart up to: 3 times ✅
  - If the task is already running, then the following rule applies: Do not start a new instance ✅
  - Stop the task if it runs longer than: Uncheck (you want it to run indefinitely)
  - Click OK → you’ll be prompted for credentials → enter them.

### 10. Configure CORS and allowed domains

1. If needed, add domains to allowed list in `backend/src/index.ts`
2. If needed, check CORS working by running the following on a different computer (not the webserver):  
3. Test with:

 ```powershell
 $h = @{
 "Origin" = "https://domain.to-test.org"
 "Access-Control-Request-Method" = "POST"
 }
 Invoke-WebRequest "https://maps3.energycenter.org/api/validate" -Method OPTIONS -Headers $h
 ```

## Modification procedure

If modifications are needed, you may need to force quit the currently running process. It doesn't always accept End commands from Task Scheduler. Remember there are two services running. The backend service is listening on Port `3000`, the batch-tool service on Port `3001`

1. Check to see if a previously started process is listening on port `3000` or `3001`:

 ```powershell
 netstat -ano | findstr :3000
 netstat -ano | findstr :3001
 ```

1. Force quit the running process:

 ```powershell
 Stop-Process -Id <PID_FROM_ABOVE> -Force
 Stop-Process -Id <PID_FROM_ABOVE> -Force
 ```

1. Make changes by pulling repo branches or similar. If necessary, rebuilding using `bun run build:widget` or similar.
1. Restart the service from the Task Scheduler GUI or with

 ```powershell
 schtasks /Run /TN "EBD Address Tool backend"
 schtasks /Run /TN "EBD Address Batch Tool"
 ```

1. If modified, copy html into relevant inetpub folder.

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

- Renders the input form and results table.
- Calls your backend APIs for validation and overlay.
- Adopts your site’s CSS styling.

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
