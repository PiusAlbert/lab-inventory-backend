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
 * Returns all labs (active + inactive) — SUPER_ADMIN only.
 * Used by the frontend lab switcher dropdown and the Laboratories management page.
 */
router.get("/", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("laboratories")
      .select("id, name, location, is_active, created_at")
      .order("name");

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Get laboratories error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/laboratories
 * Create a new laboratory — SUPER_ADMIN only.
 */
router.post("/", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { name, location } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Laboratory name is required" });
    }

    const { data, error } = await supabase
      .from("laboratories")
      .insert({ name: name.trim(), location: location?.trim() || null, is_active: true })
      .select("id, name, location, is_active, created_at")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("Create laboratory error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A laboratory with this name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/laboratories/:id
 * Update a laboratory's name and/or location — SUPER_ADMIN only.
 */
router.patch("/:id", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { name, location } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Laboratory name is required" });
    }

    const { data, error } = await supabase
      .from("laboratories")
      .update({ name: name.trim(), location: location?.trim() || null })
      .eq("id", req.params.id)
      .select("id, name, location, is_active, created_at")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Laboratory not found" });
    res.json(data);
  } catch (err) {
    console.error("Update laboratory error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A laboratory with this name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/laboratories/:id/toggle
 * Activate or deactivate a laboratory — SUPER_ADMIN only.
 */
router.patch("/:id/toggle", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const supabase = getSupabase();

    const { data: current, error: fetchErr } = await supabase
      .from("laboratories")
      .select("id, is_active")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !current) return res.status(404).json({ error: "Laboratory not found" });

    const { data, error } = await supabase
      .from("laboratories")
      .update({ is_active: !current.is_active })
      .eq("id", req.params.id)
      .select("id, name, location, is_active, created_at")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Toggle laboratory error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;