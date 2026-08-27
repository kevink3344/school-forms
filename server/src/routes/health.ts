import { Router } from "express";
import { isDbReady } from "../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    ok: true,
    dbReady: isDbReady(),
    uptime: process.uptime(),
  });
});
