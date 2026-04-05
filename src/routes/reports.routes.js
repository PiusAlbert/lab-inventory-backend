import { Router } from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { getReport } from "../controllers/reports.controller.js";

const router = Router();

router.get(
  "/",
  verifyToken,
  requireRole(["SUPER_ADMIN", "ADMIN", "LAB_MANAGER"]),
  getReport
);

export default router;