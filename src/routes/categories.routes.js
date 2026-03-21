import express from "express";
import { getSupabase } from "../config/supabase.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";

const router = express.Router();

/**
 * Categories are GLOBAL — no laboratory_id column exists on this table.
 * All labs share the same category list.
 */

router.get("/", verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("name");
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Get categories error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/", verifyToken, requireRole(["LAB_MANAGER", "SUPER_ADMIN"]), async (req, res) => {
  try {
    const { name, description, is_hazardous } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("categories")
      .insert([{ name, description, is_hazardous }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Create category error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", verifyToken, requireRole(["LAB_MANAGER", "SUPER_ADMIN"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_hazardous } = req.body;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("categories")
      .update({ name, description, is_hazardous })
      .eq("id", id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    console.error("Update category error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", verifyToken, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();
    const { error } = await supabase
      .from("categories")
      .delete()
      .eq("id", id);
    if (error) throw error;
    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("Delete category error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;