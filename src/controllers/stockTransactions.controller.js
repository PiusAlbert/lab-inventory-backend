import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

const supabase = getSupabase();

/**
 * GET /api/transactions
 */
export const getTransactions = async (req, res) => {

  const labId = req.user.laboratory_id;

  try {

    const { data, error } = await supabase
      .from("stock_transactions")
      .select(`
        *,
        items(name, sku),
        stock_batches(batch_number)
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error("getTransactions error:", err);

    res.status(500).json({ error: err.message });

  }

};


/**
 * ISSUE STOCK (FIFO)
 */
export const issueStock = async (req, res) => {

  const labId = req.user.laboratory_id;
  const userId = req.user.id;

  const { item_id, quantity, reference, notes } = req.body;

  try {

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    /**
     * Fetch batches ordered FIFO
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
      return res.status(400).json({
        error: "No available stock"
      });
    }

    let remaining = quantity;

    for (const batch of batches) {

      if (remaining <= 0) break;

      const deduct = Math.min(batch.current_quantity, remaining);

      const newQty = batch.current_quantity - deduct;

      /**
       * Update batch quantity
       */

      const { error: batchError } = await supabase
        .from("stock_batches")
        .update({
          current_quantity: newQty
        })
        .eq("id", batch.id);

      if (batchError) throw batchError;

      /**
       * Insert transaction
       */

      const { error: trxError } = await supabase
        .from("stock_transactions")
        .insert({
          id: uuidv4(),
          item_id,
          batch_id: batch.id,
          laboratory_id: labId,
          transaction_type: "ISSUE",
          quantity: deduct,
          reference,
          notes,
          created_by: userId,
          created_at: new Date()
        });

      if (trxError) throw trxError;

      remaining -= deduct;
    }

    if (remaining > 0) {
      return res.status(400).json({
        error: "Insufficient stock"
      });
    }

    res.status(201).json({
      message: "Stock issued successfully"
    });

  } catch (err) {

    console.error("issueStock error:", err);

    res.status(500).json({ error: err.message });

  }

};


/**
 * RECEIVE STOCK
 */
export const receiveStock = async (req, res) => {

  const labId = req.user.laboratory_id;
  const userId = req.user.id;

  const {
    item_id,
    batch_id,
    quantity,
    reference,
    notes
  } = req.body;

  try {

    if (quantity <= 0) {
      return res.status(400).json({
        error: "Invalid quantity"
      });
    }

    const { data: batch, error: batchError } = await supabase
      .from("stock_batches")
      .select("*")
      .eq("id", batch_id)
      .eq("laboratory_id", labId)
      .single();

    if (batchError || !batch) {
      return res.status(404).json({
        error: "Batch not found"
      });
    }

    const newQty = batch.current_quantity + quantity;

    const { error: updateError } = await supabase
      .from("stock_batches")
      .update({
        current_quantity: newQty
      })
      .eq("id", batch_id);

    if (updateError) throw updateError;

    const { error: trxError } = await supabase
      .from("stock_transactions")
      .insert({
        id: uuidv4(),
        item_id,
        batch_id,
        laboratory_id: labId,
        transaction_type: "RECEIVE",
        quantity,
        reference,
        notes,
        created_by: userId,
        created_at: new Date()
      });

    if (trxError) throw trxError;

    res.status(201).json({
      message: "Stock received"
    });

  } catch (err) {

    console.error("receiveStock error:", err);

    res.status(500).json({ error: err.message });

  }

};