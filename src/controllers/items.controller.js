import getSupabase from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Utility: Write Audit Log
 */
async function writeAuditLog({
  userId,
  labId,
  action,
  entity,
  entityId,
  oldData = null,
  newData = null
}) {

  const supabase = getSupabase();

  const { error } = await supabase.from("audit_logs").insert({
    id: uuidv4(),
    user_id: userId,
    laboratory_id: labId,
    action,
    entity,
    entity_id: entityId,
    old_data: oldData,
    new_data: newData,
    created_at: new Date()
  });

  if (error) {
    console.error("Audit log error:", error);
  }
}

/**
 * GET /api/items
 */
export const getItems = async (req, res) => {

  const supabase = getSupabase();

  try {

    const labId = req.user.laboratory_id;

    const { data, error } = await supabase
      .from("items")
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * SEARCH ITEMS
 */
export const searchItems = async (req, res) => {

  const supabase = getSupabase();

  const labId = req.user.laboratory_id;

  const {
    search = "",
    category,
    low_stock,
    page = 1,
    limit = 20,
    sort = "created_at"
  } = req.query;

  const offset = (page - 1) * limit;

  try {

    let query = supabase
      .from("items")
      .select(`
        *,
        categories(name),
        suppliers(name)
      `, { count: "exact" })
      .eq("laboratory_id", labId);

    if (search) {
      query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    }

    if (category) {
      query = query.eq("category_id", category);
    }

    query = query.order(sort, { ascending: true });

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    let filteredData = data;

    if (low_stock === "true") {

      const { data: batches } = await supabase
        .from("stock_batches")
        .select("item_id,current_quantity");

      const stockMap = {};

      batches.forEach(b => {
        stockMap[b.item_id] =
          (stockMap[b.item_id] || 0) + b.current_quantity;
      });

      filteredData = data.filter(i =>
        (stockMap[i.id] || 0) < i.minimum_threshold
      );
    }

    res.json({
      data: filteredData,
      pagination: {
        total: count,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(count / limit)
      }
    });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }
};

/**
 * GET ITEM BY ID
 */
export const getItemById = async (req, res) => {

  const supabase = getSupabase();

  try {

    const labId = req.user.laboratory_id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from("items")
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq("id", id)
      .eq("laboratory_id", labId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * CREATE ITEM
 */
export const createItem = async (req, res) => {

  const supabase = getSupabase();

  const labId = req.user.laboratory_id;
  const userId = req.user.id;

  const {
    category_id,
    supplier_id,
    name,
    sku,
    barcode,
    unit_of_measure,
    minimum_threshold,
    reorder_quantity,
    max_stock_level,
    hazard_class,
    storage_condition,
    regulatory_notes,
    is_perishable,
    item_type,
    extension_data = {}
  } = req.body;

  try {

    const { data: category } = await supabase
      .from("categories")
      .select("id")
      .eq("id", category_id)
      .eq("laboratory_id", labId)
      .single();

    if (!category) {
      return res.status(400).json({
        error: "Invalid category for this laboratory"
      });
    }

    const { data: existing } = await supabase
      .from("items")
      .select("id")
      .eq("laboratory_id", labId)
      .eq("sku", sku)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        error: "SKU already exists in this laboratory"
      });
    }

    const itemId = uuidv4();

    const { error: itemError } = await supabase
      .from("items")
      .insert({
        id: itemId,
        laboratory_id: labId,
        category_id,
        supplier_id,
        name,
        sku,
        barcode,
        unit_of_measure,
        minimum_threshold,
        reorder_quantity,
        max_stock_level,
        hazard_class,
        storage_condition,
        regulatory_notes,
        is_perishable,
        item_type,
        created_at: new Date()
      });

    if (itemError) throw itemError;

    await insertExtensionTable(item_type, itemId, extension_data);

    await writeAuditLog({
      userId,
      labId,
      action: "CREATE",
      entity: "ITEM",
      entityId: itemId,
      newData: req.body
    });

    const { data: newItem } = await supabase
      .from("items")
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq("id", itemId)
      .single();

    res.status(201).json(newItem);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * UPDATE ITEM
 */
export const updateItem = async (req, res) => {

  const supabase = getSupabase();

  const labId = req.user.laboratory_id;
  const userId = req.user.id;
  const { id } = req.params;

  try {

    const { data: existingItem } = await supabase
      .from("items")
      .select("*")
      .eq("id", id)
      .eq("laboratory_id", labId)
      .single();

    if (!existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    const { error } = await supabase
      .from("items")
      .update(req.body)
      .eq("id", id)
      .eq("laboratory_id", labId);

    if (error) throw error;

    await writeAuditLog({
      userId,
      labId,
      action: "UPDATE",
      entity: "ITEM",
      entityId: id,
      oldData: existingItem,
      newData: req.body
    });

    res.json({ message: "Item updated successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE ITEM
 */
export const deleteItem = async (req, res) => {

  const supabase = getSupabase();

  const labId = req.user.laboratory_id;
  const userId = req.user.id;
  const { id } = req.params;

  try {

    const { data: existingItem } = await supabase
      .from("items")
      .select("*")
      .eq("id", id)
      .eq("laboratory_id", labId)
      .single();

    if (!existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    const { error } = await supabase
      .from("items")
      .delete()
      .eq("id", id)
      .eq("laboratory_id", labId);

    if (error) throw error;

    await writeAuditLog({
      userId,
      labId,
      action: "DELETE",
      entity: "ITEM",
      entityId: id,
      oldData: existingItem
    });

    res.json({ message: "Item deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * EXTENSION TABLE INSERT
 */
async function insertExtensionTable(itemType, itemId, data = {}) {

  const supabase = getSupabase();

  const tableMap = {
    CHEMICAL: "item_chemical_details",
    EQUIPMENT: "item_equipment_details",
    CRM: "item_reference_details"
  };

  const tableName = tableMap[itemType];
  if (!tableName) return;

  const { error } = await supabase
    .from(tableName)
    .insert({ item_id: itemId, ...data });

  if (error) throw error;
}