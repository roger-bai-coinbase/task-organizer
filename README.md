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
| `npm run preview` | Serve the production build locally (run `build` first) |
| `npm run lint` | Run ESLint on the project |

## Optional configuration

If the app uses a `.env` file for local settings, copy or create it from any example your team provides before running. Do not commit secrets or credentials.
