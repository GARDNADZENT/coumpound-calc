# Compound Pro — Trading Goal Tracker

A compound trading calculator with Deriv account integration. The frontend is a React SPA built by `artifacts/compound-calculator`, and the API/static server is `artifacts/api-server`.

## Architecture

```
artifacts/
  compound-calculator   → Vite React frontend (dist/public/)
  api-server            → Express 5 API + static file server
  mockup-sandbox        → Design preview sandbox (Vite)
```

### How Serving Works

1. Build the frontend: `pnpm run build` (outputs to `artifacts/compound-calculator/dist/public/`)
2. The API server serves:
   - `/api/*` → Express routes
   - `/` and SPA routes → `artifacts/compound-calculator/dist/public/index.html`
   - Static assets → `express.static` pointing at the built frontend

---

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build Everything

```bash
PORT=5173 BASE_PATH=/ pnpm run build
```

### 3. Run the Production Server

```bash
cd artifacts/api-server
PORT=5000 node --enable-source-maps ./dist/index.mjs
```

Then open `http://<host>:5000/`.

### 4. Setup Autostart (systemd user service)

```bash
mkdir -p ~/.config/systemd/user
cp /home/server/apps/Trading-Goal-Tracker/scripts/trading-goal-tracker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now trading-goal-tracker.service
```

---

## Diagnostics

```bash
systemctl --user status trading-goal-tracker.service
journalctl --user -u trading-goal-tracker.service -f
curl -s http://localhost:5000/api/healthz
```
