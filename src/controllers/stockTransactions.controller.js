import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";


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
 * ISSUE STOCK (Atomic via RPC)
 */
export const issueStock = async (req, res) => {
  const supabase = getSupabase()

  const labId = req.user.laboratory_id
  const userId = req.user.id

  const { item_id, quantity, reference, notes } = req.body

  try {

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" })
    }

    const { error } = await supabase.rpc("issue_stock_fifo", {
      p_item_id: item_id,
      p_lab_id: labId,
      p_quantity: quantity,
      p_reference: reference,
      p_notes: notes,
      p_user_id: userId
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.status(201).json({
      message: "Stock issued successfully"
    })

  } catch (err) {

    console.error("issueStock error:", err)

    res.status(500).json({
      error: "Failed to issue stock"
    })

  }
}

/**
 * RECEIVE STOCK
 */
export const receiveStock = async (req, res) => {
  const supabase = getSupabase();
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