# Productivity

Local board app for projects and task notes (React + TypeScript + Vite).

## Prerequisites

- **Node.js** 20 or newer (LTS recommended)
- **npm** 10+ (bundled with Node)

Check versions:

```bash
node -v
npm -v
```

## Install

From the project root:

```bash
npm install
```

Use the directory where you cloned or copied this project. Run `npm install` again after pulling changes that update `package.json` or the lockfile.

## Run (development)

Starts the Vite dev server with hot reload:

```bash
npm run dev
```

Open the URL printed in the terminal (by default **http://localhost:5173**).

## Other commands

| Command | Description |
| -------- | ----------- |
| `npm run build` | Typecheck and produce a production build in `dist/` |
| `npm run typecheck` | Run the TypeScript project checks without bundling |
| `npm run test` | Run unit tests |
| `npm run check` | Run lint, typecheck, tests, and build |
| `npm run preview` | Serve the production build locally (run `build` first) |
| `npm run lint` | Run ESLint on the project |

## Local persistence

The app saves board state and task change events in two places:

- Browser `localStorage`, so the board still works in static preview or file-only use.
- `.local-data/board.json` and `.local-data/task-events.json` through the Vite dev/preview middleware.

When running under `npm run dev` or `npm run preview`, disk data is loaded first. If disk data is missing, the app falls back to `localStorage`. `.local-data/` is ignored by git.

## Weekly reports

The **Weekly Report** button builds a task-change diff, sends that diff and any task links to an OpenAI-compatible chat completions API, and writes the generated markdown under `reports/`. Reports are local generated artifacts and are ignored by git.

Report generation only works when the Vite middleware is running (`npm run dev` or `npm run preview`) and an LLM API key is configured. If no key is configured, no report is generated.

## Optional configuration

Copy `.env.example` to `.env` for local weekly report settings:

```bash
cp .env.example .env
```

Set `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` for your OpenAI-compatible provider. `OPENAI_API_KEY` and `OPENAI_BASE_URL` aliases are also supported. Do not commit secrets or credentials.
