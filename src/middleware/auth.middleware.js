import { getSupabase } from "../config/supabase.js"

/**
 * VERIFY SUPABASE JWT
 *
 * Role and laboratory assignment come from public.app_users — NOT JWT metadata.
 *
 * Behavior:
 * - Regular users:
 *     req.user.laboratory_id = app_users.laboratory_id
 *
 * - SUPER_ADMIN:
 *     app_users.laboratory_id remains null in the database
 *     req.user.laboratory_id becomes:
 *       - selected lab from x-lab-id, if present
 *       - null if no lab is selected (all-labs read mode)
 *
 * This lets SUPER_ADMIN browse across labs while still requiring an
 * explicit selected lab for lab-scoped write operations.
 */
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid authorization header",
      })
    }

    const token = authHeader.split(" ")[1]
    const supabase = getSupabase()

    // 1. Verify JWT with Supabase Auth
    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired token",
      })
    }

    const authUser = data.user

    // 2. Load application profile from app_users
    const { data: appUser, error: appError } = await supabase
      .from("app_users")
      .select("id, full_name, role, laboratory_id, is_active")
      .eq("id", authUser.id)
      .maybeSingle()

    if (appError) {
      console.error("app_users lookup error:", appError.message)
      return res.status(500).json({
        error: "Failed to load user profile",
      })
    }

    if (!appUser) {
      return res.status(403).json({
        error: "User profile not found. Contact your administrator.",
      })
    }

    if (!appUser.is_active) {
      return res.status(403).json({
        error: "User account is deactivated",
      })
    }

    if (!appUser.role) {
      return res.status(403).json({
        error: "User has no role assigned",
      })
    }

    const isSuperAdmin = appUser.role === "SUPER_ADMIN"

    if (!isSuperAdmin && !appUser.laboratory_id) {
      return res.status(403).json({
        error: "User has no laboratory assigned",
      })
    }

    /**
     * Sanitize x-lab-id.
     * Frontend may accidentally send "null", "undefined", or empty strings.
     * Treat those as absent.
     */
    const rawLabOverride = req.headers["x-lab-id"]

    const labOverride =
      rawLabOverride &&
      rawLabOverride !== "null" &&
      rawLabOverride !== "undefined" &&
      String(rawLabOverride).trim() !== ""
        ? String(rawLabOverride).trim()
        : null

    /**
     * Optional validation:
     * If SUPER_ADMIN passed x-lab-id, make sure that laboratory exists and is active.
     */
    let validatedLabOverride = null

    if (isSuperAdmin && labOverride) {
      const { data: lab, error: labError } = await supabase
        .from("laboratories")
        .select("id, is_active")
        .eq("id", labOverride)
        .maybeSingle()

      if (labError) {
        console.error("laboratory lookup error:", labError.message)
        return res.status(500).json({
          error: "Failed to validate selected laboratory",
        })
      }

      if (!lab || lab.is_active === false) {
        return res.status(400).json({
          error: "Selected laboratory is invalid or inactive",
        })
      }

      validatedLabOverride = lab.id
    }

    /**
     * Effective lab:
     * - SUPER_ADMIN + selected lab    -> selected lab UUID
     * - SUPER_ADMIN + no selected lab -> null (all-labs mode)
     * - Regular user                  -> assigned laboratory_id
     */
    const effectiveLabId = isSuperAdmin
      ? validatedLabOverride
      : appUser.laboratory_id

    req.user = {
      id: authUser.id,
      email: authUser.email,
      full_name: appUser.full_name,
      role: appUser.role,
      is_admin: isSuperAdmin,
      profile_laboratory_id: appUser.laboratory_id ?? null,
      laboratory_id: effectiveLabId, // this is the EFFECTIVE lab used by controllers
      selected_laboratory_id: validatedLabOverride,
    }

    return next()
  } catch (err) {
    console.error("verifyToken error:", err)
    return res.status(500).json({
      error: "Authentication failed",
    })
  }
}