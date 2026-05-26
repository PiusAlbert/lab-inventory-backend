import express from "express";
import { getSupabase } from "../config/supabase.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";

const router = express.Router();

/**
 * GET /api/laboratories/public
 * Returns active labs for student registration — no auth required.
 */
router.get("/public", async (_req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("laboratories")
      .select("id, name, location")
      .eq("is_active", true)
      .order("name");
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Get public laboratories error:", err);
    res.status(500).json({ error: "Failed to load laboratories" });
  }
});

/**
 * GET /api/laboratories
 * Returns all labs — SUPER_ADMIN only.
 * Used by the frontend lab switcher dropdown.
 */
router.get("/", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("laboratories")
      .select("id, name, location, is_active")
      .eq("is_active", true)
      .order("name");

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Get laboratories error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;