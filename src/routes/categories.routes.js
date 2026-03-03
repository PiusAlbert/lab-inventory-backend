const express = require("express");
const getSupabase = require("../lib/supabase");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("name");

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;