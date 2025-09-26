This project provides a web-based tool for the Equitable Building Decarbonization (EBD) program.
It validates user-provided addresses, performs spatial overlay, and checks eligibility based on census tract.

**Features**

    * Address validation + geocoding via Smarty US Street API.

    * Spatial overlay with ArcGIS services.

    * Program logic:

        + Maps census tract → region + eligibility (via local CSV).

        + If outside Central region → show region + redirect link.

        + If inside Central but ineligible → request email for notifications.

    * Frontend: Vite + TypeScript (vanilla template).

    * Backend: Hono + Bun.

    * Developer tooling:

        + Biome for linting/formatting.

        + Husky pre-commit hooks.


**Getting Started**

1. Clone Repository

```bash
git clone https://github.com/CenterForSustainableEnergy/ebd-addresseligibility-tool.git
cd <your repo location>

```


2. To install dependencies:

```bash
bun install
```

3. Environmental Variables
Create a new .env file at repo root. Contact John Anderson for Smarty Key access. 

```ini
SMARTY_AUTH_ID=your-smarty-id
SMARTY_AUTH_TOKEN=your-smarty-token
PORT=3000
```
.env is ignored by Git — do not commit it.

4. Run backend

```bash
bun run backend/src/index.ts
```

Backend starts on http://localhost:3000.

5. Run frontend

```bash
cd frontend
bun run dev
```

Frontend starts on http://localhost:5173 and proxies /api requests to the backend.

6. Combined dev (frontend + backend)

At the repo root:

```bash
bun add -D concurrently 
bun run dev
```
This runs both with concurrently.

Developer Workflow

Lint/format check:

```bash
bun run biome check .
```

Auto-fix:

```bash
bun run biome check --apply .
```

Git hooks: Husky runs Biome automatically before each commit.

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
