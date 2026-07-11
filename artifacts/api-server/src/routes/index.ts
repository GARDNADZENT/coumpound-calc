import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter, { handleCallback } from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
// Deriv redirects here (registered redirect URL: https://traderspulse.site/callback)
router.get("/callback", handleCallback);

export default router;
