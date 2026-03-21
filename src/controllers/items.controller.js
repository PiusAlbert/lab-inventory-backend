import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

async function writeAuditLog({ userId, action, entity, entityId, oldData = null, newData = null }) {
  const supabase = getSupabase();
  const { error } = await supabase.from("audit_logs").insert({
    id:             uuidv4(),
    user_id:        userId,
    action,
    table_affected: entity,
    record_id:      entityId,
    created_at:     new Date(),
    details:        { old_data: oldData, new_data: newData }
  });
  if (error) console.error("Audit log error:", error);
}

export const getItems = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  try {
    let query = supabase
      .from("items")
      .select(`*, categories(name), suppliers(name)`)
      .order("created_at", { ascending: false });

    if (labId) query = query.eq("laboratory_id", labId);

    const { data, error } = await query;
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const searchItems = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const { search = "", category, low_stock, page = 1, limit = 20, sort = "created_at" } = req.query;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("items")
      .select(`*, categories(name), suppliers(name)`, { count: "exact" });

    if (labId)    query = query.eq("laboratory_id", labId);
    if (search)   query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    if (category) query = query.eq("category_id", category);

    query = query.order(sort, { ascending: true }).range(offset, offset + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    let filteredData = data;
    if (low_stock === "true") {
      let bq = supabase.from("stock_batches").select("item_id, current_quantity");
      if (labId) bq = bq.eq("laboratory_id", labId);
      const { data: batches } = await bq;
      const stockMap = {};
      (batches || []).forEach(b => {
        stockMap[b.item_id] = (stockMap[b.item_id] || 0) + b.current_quantity;
      });
      filteredData = data.filter(i => (stockMap[i.id] || 0) < i.minimum_threshold);
    }

    res.json({
      data: filteredData,
      pagination: { total: count, page: Number(page), limit: Number(limit), pages: Math.ceil(count / limit) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/items/:id
 *
 * Explicitly joins all three extension tables.
 * After importing item_chemical_details / item_equipment_details / item_reference_details,
 * PostgREST needs these to be declared explicitly in the select string so it can
 * resolve the FK relationships without ambiguity.
 * Items that don't have a row in an extension table will return null for that object.
 */
export const getItemById = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const { id }   = req.params;

  try {
    let query = supabase
      .from("items")
      .select(`
        *,
        categories ( name ),
        suppliers  ( name ),
        item_chemical_details (
          formula,
          cas_number,
          molecular_weight,
          msds_url,
          pubchem_id,
          ghp_classification
        ),
        item_equipment_details (
          model_number,
          serial_number,
          maintenance_interval_days,
          last_maintenance_date,
          warranty_expiry
        ),
        item_reference_details (
          certification_number,
          certification_expiry,
          issuing_body
        )
      `)
      .eq("id", id);

    if (labId) query = query.eq("laboratory_id", labId);

    const { data, error } = await query.single();

    if (error || !data) {
      return res.status(404).json({ error: "Item not found" });
    }
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const createItem = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id;
  const userId   = req.user.id;

  if (!labId) {
    return res.status(400).json({ error: "Please select a laboratory before adding items" });
  }

  const {
    category_id, supplier_id, name, sku, barcode,
    unit_of_measure, minimum_threshold, reorder_quantity,
    max_stock_level, hazard_class, storage_condition,
    regulatory_notes, is_perishable, item_type, extension_data = {}
  } = req.body;

  try {
    const { data: category } = await supabase
      .from("categories").select("id").eq("id", category_id).single();
    if (!category) return res.status(400).json({ error: "Invalid category" });

    if (item_type === "CHEMICAL" && !hazard_class)
      return res.status(400).json({ error: "Hazard class required for chemical items" });
    if (item_type === "EQUIPMENT" && !extension_data?.maintenance_interval_days)
      return res.status(400).json({ error: "Maintenance interval required for equipment" });
    if (item_type === "CRM" && !extension_data?.certification_expiry)
      return res.status(400).json({ error: "Certification expiry required for CRM" });

    const { data: existing } = await supabase
      .from("items").select("id").eq("laboratory_id", labId).eq("sku", sku).maybeSingle();
    if (existing) return res.status(400).json({ error: "SKU already exists in this laboratory" });

    const itemId = uuidv4();
    const { error: itemError } = await supabase.from("items").insert({
      id: itemId, laboratory_id: labId, category_id, supplier_id,
      name, sku, barcode, unit_of_measure, minimum_threshold,
      reorder_quantity, max_stock_level, hazard_class, storage_condition,
      regulatory_notes, is_perishable, item_type
    });
    if (itemError) throw itemError;

    await insertExtensionTable(item_type, itemId, extension_data);
    await writeAuditLog({ userId, action: "CREATE", entity: "items", entityId: itemId, newData: req.body });

    const { data: newItem } = await supabase
      .from("items").select(`*, categories(name), suppliers(name)`).eq("id", itemId).single();
    return res.status(201).json(newItem);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const updateItem = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const userId   = req.user.id;
  const { id }   = req.params;

  try {
    let q = supabase.from("items").select("*").eq("id", id);
    if (labId) q = q.eq("laboratory_id", labId);
    const { data: existingItem } = await q.single();
    if (!existingItem) return res.status(404).json({ error: "Item not found" });

    let uq = supabase.from("items").update(req.body).eq("id", id);
    if (labId) uq = uq.eq("laboratory_id", labId);
    const { error } = await uq;
    if (error) throw error;

    await writeAuditLog({ userId, action: "UPDATE", entity: "items", entityId: id, oldData: existingItem, newData: req.body });
    return res.json({ message: "Item updated successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const deleteItem = async (req, res) => {
  const supabase = getSupabase();
  const labId    = req.user.laboratory_id ?? null;
  const userId   = req.user.id;
  const { id }   = req.params;

  try {
    let q = supabase.from("items").select("*").eq("id", id);
    if (labId) q = q.eq("laboratory_id", labId);
    const { data: existingItem } = await q.single();
    if (!existingItem) return res.status(404).json({ error: "Item not found" });

    let dq = supabase.from("items").delete().eq("id", id);
    if (labId) dq = dq.eq("laboratory_id", labId);
    const { error } = await dq;
    if (error) throw error;

    await writeAuditLog({ userId, action: "DELETE", entity: "items", entityId: id, oldData: existingItem });
    return res.json({ message: "Item deleted successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function insertExtensionTable(itemType, itemId, data = {}) {
  const supabase = getSupabase();
  const tableMap = {
    CHEMICAL:  "item_chemical_details",
    EQUIPMENT: "item_equipment_details",
    CRM:       "item_reference_details"
  };
  const tableName = tableMap[itemType];
  if (!tableName) return;
  const { error } = await supabase.from(tableName).insert({ item_id: itemId, ...data });
  if (error) throw error;
}