import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * DUAL-UNIT ARCHITECTURE
 *
 * items.unit_of_measure  = packaging/stock unit  (bottle, kg, box)
 * items.dispensing_unit  = usage unit             (ml, g, mg)      — null = same unit
 * items.conversion_factor = dispensing_units per stock unit        — null = 1
 *
 * Batches ALWAYS store current_quantity in dispensing_unit (base unit).
 * If dispensing_unit is null → no conversion, behaves exactly as before.
 *
 * Receive: user enters stock units → system multiplies by conversion_factor → stores base qty
 * Issue:   user enters dispensing units directly → deducted from base qty
 */

export const getBatches = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  try {
    let query = supabase
      .from("stock_batches")
      .select(`
        *,
        items (
          id, name, sku,
          unit_of_measure, dispensing_unit, conversion_factor,
          minimum_threshold, categories(name)
        )
      `)
      .order("created_at", { ascending: false });

    if (labId) query = query.eq("laboratory_id", labId);
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const getBatchesByItem = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const { itemId } = req.params;
  try {
    let query = supabase
      .from("stock_batches")
      .select(`
        *,
        items ( id, name, sku, unit_of_measure, dispensing_unit, conversion_factor )
      `)
      .eq("item_id", itemId)
      .order("expiry_date", { ascending: true });

    if (labId) query = query.eq("laboratory_id", labId);
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/batches
 *
 * Body:
 *   item_id            — uuid
 *   batch_number       — string (optional)
 *   quantity_received  — number IN STOCK UNITS (e.g. 2 for 2 bottles)
 *   expiry_date        — ISO date string
 *   storage_location   — string
 *
 * The controller fetches the item's conversion_factor and stores
 * quantity_received × conversion_factor as current_quantity (base/dispensing units).
 */
export const receiveBatch = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id;
  const userId   = req.user.id;

  if (!labId) {
    return res.status(400).json({
      error: "Please select a laboratory before receiving stock"
    });
  }

  const { item_id, batch_number, quantity_received, expiry_date, storage_location } = req.body;

  try {
    const qty = Number(quantity_received);
    if (!qty || qty <= 0) return res.status(400).json({ error: "Invalid quantity" });
    if (!item_id)         return res.status(400).json({ error: "item_id is required" });

    // Fetch item for conversion
    const { data: item, error: itemErr } = await supabase
      .from("items")
      .select("id, unit_of_measure, dispensing_unit, conversion_factor")
      .eq("id", item_id)
      .single();

    if (itemErr || !item) return res.status(404).json({ error: "Item not found" });

    const factor  = item.conversion_factor ? Number(item.conversion_factor) : 1;
    const baseQty = parseFloat((qty * factor).toFixed(4));

    const { data: batch, error: batchErr } = await supabase
      .from("stock_batches")
      .insert({
        id:                uuidv4(),
        item_id,
        laboratory_id:     labId,
        batch_number:      batch_number   || null,
        quantity_received: baseQty,         // always in dispensing/base units
        current_quantity:  baseQty,
        expiry_date:       expiry_date    || null,
        storage_location:  storage_location || null,
        received_at:       new Date(),
        created_by:        userId,
        created_at:        new Date(),
      })
      .select()
      .single();

    if (batchErr) throw batchErr;

    return res.status(201).json({
      ...batch,
      _conversion: {
        stock_units_received: qty,
        stock_unit:           item.unit_of_measure,
        base_qty_stored:      baseQty,
        base_unit:            item.dispensing_unit || item.unit_of_measure,
        factor,
      }
    });
  } catch (err) {
    console.error("receiveBatch error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const updateBatch = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const { id }   = req.params;
  try {
    let q = supabase.from("stock_batches").update(req.body).eq("id", id);
    if (labId) q = q.eq("laboratory_id", labId);
    const { error } = await q;
    if (error) throw error;
    return res.json({ message: "Batch updated" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const deleteBatch = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const { id }   = req.params;
  try {
    let q = supabase.from("stock_batches").delete().eq("id", id);
    if (labId) q = q.eq("laboratory_id", labId);
    const { error } = await q;
    if (error) throw error;
    return res.json({ message: "Batch deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};