import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { handleCallback } from "./routes/auth";
import { logger } from "./lib/logger";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Deriv OAuth callback — must be at root to match redirect_uri (https://traderspulse.site/callback)
app.get("/callback", handleCallback);

app.use("/api", router);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, "..", "..", "compound-calculator", "dist", "public");
const indexPath = path.join(frontendDist, "index.html");

if (fs.existsSync(indexPath)) {
  app.use(express.static(frontendDist));

  app.use((req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not Found" });
    }
    return res.sendFile(indexPath);
  });
}

export default app;
