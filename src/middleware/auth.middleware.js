import { getSupabase } from "../config/supabase.js";

/**
 * VERIFY SUPABASE JWT
 *
 * Role and laboratory_id come from the app_users table — NOT JWT metadata.
 * JWT metadata only has email_verified for this project.
 *
 * SUPER_ADMIN has laboratory_id = null in app_users — this is valid.
 * They can pass x-lab-id header to scope requests to a specific lab.
 *
 * The string "null" or "undefined" in x-lab-id is treated as absent.
 */
export const verifyToken = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.split(" ")[1];
    const supabase = getSupabase();

    // 1 — verify JWT with Supabase
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const authUser = data.user;

    // 2 — look up app_users for role and lab
    const { data: appUser, error: appError } = await supabase
      .from("app_users")
      .select("id, full_name, role, laboratory_id, is_active")
      .eq("id", authUser.id)
      .maybeSingle();

    if (appError) {
      console.error("app_users lookup error:", appError.message);
      return res.status(500).json({ error: "Failed to load user profile" });
    }

    if (!appUser) {
      return res.status(403).json({
        error: "User profile not found. Contact your administrator."
      });
    }

    if (!appUser.is_active) {
      return res.status(403).json({ error: "User account is deactivated" });
    }

    if (!appUser.role) {
      return res.status(403).json({ error: "User has no role assigned" });
    }

    const isSuperAdmin = appUser.role === "SUPER_ADMIN";

    if (!appUser.laboratory_id && !isSuperAdmin) {
      return res.status(403).json({ error: "User has no laboratory assigned" });
    }

    /**
     * Sanitize x-lab-id header.
     * Frontend may accidentally send the string "null" when selectedLabId is null.
     * Treat "null" / "undefined" / empty string as absent.
     */
    const rawLabOverride = req.headers["x-lab-id"];
    const labOverride = (
      rawLabOverride &&
      rawLabOverride !== "null" &&
      rawLabOverride !== "undefined" &&
      rawLabOverride.trim() !== ""
    ) ? rawLabOverride.trim() : null;

    /**
     * Effective lab:
     *   SUPER_ADMIN + no override  → null  (all-labs view)
     *   SUPER_ADMIN + override     → the selected lab UUID
     *   Regular user               → their assigned lab (fixed)
     */
    const effectiveLabId = isSuperAdmin
      ? labOverride
      : appUser.laboratory_id;

    req.user = {
      id:            authUser.id,
      email:         authUser.email,
      full_name:     appUser.full_name,
      role:          appUser.role,
      laboratory_id: effectiveLabId,   // null for admin with no lab selected
      is_admin:      isSuperAdmin,
    };

    next();

  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(500).json({ error: "Authentication failed" });
  }
};