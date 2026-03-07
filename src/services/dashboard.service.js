import { getSupabase } from "../config/supabase.js";

const supabase = getSupabase();

export const getDashboardMetrics = async (labId) => {

  try {

    /**
     * Total items
     */

    const { count: totalItems, error: totalError } = await supabase
      .from("items")
      .select("*", { count: "exact", head: true })
      .eq("laboratory_id", labId)
      .eq("is_active", true);

    if (totalError) throw totalError;


    /**
     * Low stock items
     */

    const { data: lowStockData, error: lowStockError } = await supabase
      .rpc("low_stock_items_count", { lab_id: labId });

    if (lowStockError) throw lowStockError;


    /**
     * Expiring batches
     */

    const { data: expiringSoon, error: expiryError } = await supabase
      .rpc("expiring_batches_count", { lab_id: labId });

    if (expiryError) throw expiryError;


    /**
     * Inventory value
     */

    const { data: inventoryValue, error: valueError } = await supabase
      .rpc("inventory_total_value", { lab_id: labId });

    if (valueError) throw valueError;


    /**
     * Recent transactions
     */

    const { data: recentTransactions, error: trxError } = await supabase
      .from("stock_transactions")
      .select(`
        *,
        items(name, sku)
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (trxError) throw trxError;


    return {
      total_items: totalItems || 0,
      low_stock: lowStockData || 0,
      expiring_soon: expiringSoon || 0,
      inventory_value: inventoryValue || 0,
      recent_transactions: recentTransactions || []
    };

  } catch (err) {

    console.error("Dashboard metrics error:", err);
    throw err;

  }

};