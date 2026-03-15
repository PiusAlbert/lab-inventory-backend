import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * GET /api/batches
 * Get all batches for the user's lab
 */
export const getBatches = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id;

  try {

    const { data, error } = await supabase
      .from("stock_batches")
      .select(`
        *,
        items(name, sku)
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error("getBatches error:", err);

    res.status(500).json({ error: err.message });

  }
};


/**
 * GET /api/items/:id/batches
 */
export const getItemBatches = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id;
  const itemId = req.params.id;

  try {

    const { data, error } = await supabase
      .from("stock_batches")
      .select("*")
      .eq("item_id", itemId)
      .eq("laboratory_id", labId)
      .order("expiry_date", { ascending: true });

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error("getItemBatches error:", err);

    res.status(500).json({ error: err.message });

  }
};


/**
 * POST /api/batches
 * Receive stock
 */
export const createBatch = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id;
  const userId = req.user.id;

  const {
    item_id,
    batch_number,
    quantity_received,
    expiry_date,
    storage_location
  } = req.body;

  try {

    /**
     * Validate item belongs to lab
     */

    const { data: item } = await supabase
      .from("items")
      .select("id")
      .eq("id", item_id)
      .eq("laboratory_id", labId)
      .single();

    if (!item) {
      return res.status(400).json({
        error: "Item does not belong to this laboratory"
      });
    }

    /**
     * Validate quantity
     */

    if (!quantity_received || quantity_received <= 0) {
      return res.status(400).json({
        error: "Quantity must be greater than zero"
      });
    }

    const batchId = uuidv4();

    const { error } = await supabase
      .from("stock_batches")
      .insert({
        id: batchId,
        item_id,
        laboratory_id: labId,
        batch_number,
        quantity_received,
        current_quantity: quantity_received,
        expiry_date,
        storage_location,
        created_by: userId,
        created_at: new Date()
      });

    if (error) throw error;

    /**
     * Return created batch
     */

    const { data: batch } = await supabase
      .from("stock_batches")
      .select(`
        *,
        items(name, sku)
      `)
      .eq("id", batchId)
      .single();

    res.status(201).json(batch);

  } catch (err) {

    console.error("createBatch error:", err);

    res.status(500).json({ error: err.message });

  }
};