import express from "express";
import {
  getItems,
  searchItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem
} from "../controllers/items.controller.js";

import { verifyToken }  from "../middleware/auth.middleware.js";
import { requireRole }  from "../middleware/role.middleware.js";

const router = express.Router();

router.use(verifyToken);

/**
 * GET /api/items/search
 * Must be declared BEFORE /:id to avoid being shadowed by the wildcard
 */
router.get("/search", searchItems);

router.get("/",    getItems);
router.get("/:id", getItemById);

router.post(
  "/",
  requireRole(["LAB_MANAGER", "SUPER_ADMIN"]),
  createItem
);

router.put(
  "/:id",
  requireRole(["LAB_MANAGER", "SUPER_ADMIN"]),
  updateItem
);

router.delete(
  "/:id",
  requireRole(["LAB_MANAGER", "SUPER_ADMIN"]),
  deleteItem
);

export default router;