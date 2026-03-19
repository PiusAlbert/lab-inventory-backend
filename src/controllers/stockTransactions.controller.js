import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Live stock_transactions schema:
 *   id, item_id, batch_id, laboratory_id, transaction_type (text),
 *   quantity, reference, notes, created_by, created_at
 *
 * transaction_type is plain text — use "ISSUE" / "RECEIVE" to match
 * what the frontend expects and what was always intended.
 */

/**
 * GET /api/transactions
 */
export const getTransactions = async (req, res) => {

  const supabase = getSupabase();
  const labId = req.user.laboratory_id;

  try {

    const { data, error } = await supabase
      .from("stock_transactions")
      .select(`
        id,
        transaction_type,
        quantity,
        reference,
        notes,
        created_at,
        items ( id, name, sku, unit_of_measure ),
        stock_batches ( batch_number )
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    res.json(data);

  } catch (err) {
    console.error("getTransactions error:", err);
    res.status(500).json({ error: err.message });
  }
};


/**
 * POST /api/transactions/issue
 * Issues stock using FIFO across batches for the given item.
 */
export const issueStock = async (req, res) => {

  const supabase = getSupabase();
  const labId  = req.user.laboratory_id;
  const userId = req.user.id;

  const { item_id, quantity, reference, notes } = req.body;

  try {

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }
    if (!item_id) {
      return res.status(400).json({ error: "item_id is required" });
    }

    /**
     * Fetch available batches FIFO (earliest expiry first)
     */
    const { data: batches, error: batchFetchError } = await supabase
      .from("stock_batches")
      .select("*")
      .eq("item_id", item_id)
      .eq("laboratory_id", labId)
      .gt("current_quantity", 0)
      .order("expiry_date", { ascending: true });

    if (batchFetchError) throw batchFetchError;

    if (!batches || batches.length === 0) {
      return res.status(400).json({ error: "No available stock for this item" });
    }

    const totalAvailable = batches.reduce(
      (sum, b) => sum + Number(b.current_quantity), 0
    );

    if (qty > totalAvailable) {
      return res.status(400).json({
        error: `Insufficient stock. Available: ${totalAvailable}`
      });
    }

    let remaining = qty;

    for (const batch of batches) {
      if (remaining <= 0) break;

      const deduct = Math.min(Number(batch.current_quantity), remaining);
      const newQty = Number(batch.current_quantity) - deduct;

      const { error: batchError } = await supabase
        .from("stock_batches")
        .update({ current_quantity: newQty })
        .eq("id", batch.id);

      if (batchError) throw batchError;

      const { error: trxError } = await supabase
        .from("stock_transactions")
        .insert({
          id:               uuidv4(),
          item_id:          item_id,
          batch_id:         batch.id,
          laboratory_id:    labId,
          transaction_type: "ISSUE",
          quantity:         deduct,
          reference:        reference || null,
          notes:            notes     || null,
          created_by:       userId,
          created_at:       new Date()
        });

      if (trxError) throw trxError;

      remaining -= deduct;
    }

    res.status(201).json({ message: "Stock issued successfully" });

  } catch (err) {
    console.error("issueStock error:", err);
    res.status(500).json({ error: err.message });
  }
};


/**
 * POST /api/transactions/receive
 * Adds quantity to an existing batch and logs the transaction.
 */
export const receiveStock = async (req, res) => {

  const supabase = getSupabase();
  const labId  = req.user.laboratory_id;
  const userId = req.user.id;

  const { item_id, batch_id, quantity, reference, notes } = req.body;

  try {

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }
    if (!batch_id) {
      return res.status(400).json({ error: "batch_id is required" });
    }

    const { data: batch, error: batchError } = await supabase
      .from("stock_batches")
      .select("*")
      .eq("id", batch_id)
      .eq("laboratory_id", labId)
      .single();

    if (batchError || !batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const newQty = Number(batch.current_quantity) + qty;

    const { error: updateError } = await supabase
      .from("stock_batches")
      .update({ current_quantity: newQty })
      .eq("id", batch_id);

    if (updateError) throw updateError;

    const { error: trxError } = await supabase
      .from("stock_transactions")
      .insert({
        id:               uuidv4(),
        item_id:          item_id || batch.item_id,
        batch_id:         batch_id,
        laboratory_id:    labId,
        transaction_type: "RECEIVE",
        quantity:         qty,
        reference:        reference || null,
        notes:            notes     || null,
        created_by:       userId,
        created_at:       new Date()
      });

    if (trxError) throw trxError;

    res.status(201).json({ message: "Stock received successfully" });

  } catch (err) {
    console.error("receiveStock error:", err);
    res.status(500).json({ error: err.message });
  }
};