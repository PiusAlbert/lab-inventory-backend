import express from "express";
import { getSupabase } from "../config/supabase.js";

import { verifyToken } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";

const router = express.Router();

/**
 * GET ALL CATEGORIES
 * Authenticated users only
 */
router.get("/", verifyToken, async (req, res) => {

  try {

    const supabase = getSupabase();

    const labId = req.user.laboratory_id;

    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .eq("laboratory_id", labId)
      .order("name");

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error("Get categories error:", err);

    res.status(500).json({ error: err.message });

  }

});


/**
 * CREATE CATEGORY
 * Only LAB_MANAGER or SUPER_ADMIN
 */
router.post(
  "/",
  verifyToken,
  requireRole("LAB_MANAGER", "SUPER_ADMIN"),
  async (req, res) => {

    try {

      const { name, description, is_hazardous } = req.body;

      const labId = req.user.laboratory_id;

      const supabase = getSupabase();

      const { data, error } = await supabase
        .from("categories")
        .insert([
          {
            name,
            description,
            is_hazardous,
            laboratory_id: labId
          }
        ])
        .select();

      if (error) throw error;

      res.status(201).json(data[0]);

    } catch (err) {

      console.error("Create category error:", err);

      res.status(500).json({ error: err.message });

    }

  }
);


/**
 * UPDATE CATEGORY
 * Only LAB_MANAGER or SUPER_ADMIN
 */
router.put(
  "/:id",
  verifyToken,
  requireRole("LAB_MANAGER", "SUPER_ADMIN"),
  async (req, res) => {

    try {

      const { id } = req.params;

      const { name, description, is_hazardous } = req.body;

      const labId = req.user.laboratory_id;

      const supabase = getSupabase();

      const { data, error } = await supabase
        .from("categories")
        .update({
          name,
          description,
          is_hazardous
        })
        .eq("id", id)
        .eq("laboratory_id", labId)
        .select();

      if (error) throw error;

      res.json(data[0]);

    } catch (err) {

      console.error("Update category error:", err);

      res.status(500).json({ error: err.message });

    }

  }
);


/**
 * DELETE CATEGORY
 * Only SUPER_ADMIN
 */
router.delete(
  "/:id",
  verifyToken,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {

    try {

      const { id } = req.params;

      const labId = req.user.laboratory_id;

      const supabase = getSupabase();

      const { error } = await supabase
        .from("categories")
        .delete()
        .eq("id", id)
        .eq("laboratory_id", labId);

      if (error) throw error;

      res.json({ message: "Category deleted" });

    } catch (err) {

      console.error("Delete category error:", err);

      res.status(500).json({ error: err.message });

    }

  }
);

export default router;