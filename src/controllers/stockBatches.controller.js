import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * GET /api/batches
 * labId null = SUPER_ADMIN all-labs view → return all batches unfiltered
 */
export const getBatches = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;

  try {
    let query = supabase
      .from("stock_batches")
      .select(`*, items(name, sku)`)
      .order("created_at", { ascending: false });

    if (labId) query = query.eq("laboratory_id", labId);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("getBatches error:", err);
    res.status(500).json({ error: err.message });
  }
};


/**
 * GET /api/batches/item/:id
 */
export const getItemBatches = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const itemId   = req.params.id;

  try {
    let query = supabase
      .from("stock_batches")
      .select("*")
      .eq("item_id", itemId)
      .order("expiry_date", { ascending: true });

    if (labId) query = query.eq("laboratory_id", labId);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("getItemBatches error:", err);
    res.status(500).json({ error: err.message });
  }
};


/**
 * POST /api/batches
 * Requires a specific lab — admin must select a lab before creating a batch
 */
export const createBatch = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id;
  const userId   = req.user.id;

  if (!labId) {
    return res.status(400).json({
      error: "Please select a laboratory before creating a batch"
    });
  }

  const { item_id, batch_number, quantity_received, expiry_date, storage_location } = req.body;

  try {
    if (!quantity_received || quantity_received <= 0) {
      return res.status(400).json({ error: "Quantity must be greater than zero" });
    }

    const { data: item } = await supabase
      .from("items")
      .select("id")
      .eq("id", item_id)
      .eq("laboratory_id", labId)
      .single();

    if (!item) {
      return res.status(400).json({ error: "Item does not belong to this laboratory" });
    }

    const batchId = uuidv4();

    const { error } = await supabase
      .from("stock_batches")
      .insert({
        id:               batchId,
        item_id,
        laboratory_id:    labId,
        batch_number,
        quantity_received,
        current_quantity: quantity_received,
        expiry_date,
        storage_location,
        created_by:       userId,
      });

    if (error) throw error;

    const { data: batch } = await supabase
      .from("stock_batches")
      .select(`*, items(name, sku)`)
      .eq("id", batchId)
      .single();

    res.status(201).json(batch);
  } catch (err) {
    console.error("createBatch error:", err);
    res.status(500).json({ error: err.message });
  }
};