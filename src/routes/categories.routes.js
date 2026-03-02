const express = require("express");
const supabase = require("../lib/supabase");

const router = express.Router();

// GET all categories (read-only)
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, description, is_hazardous")
    .order("name");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

module.exports = router;