import { getSupabase } from "../config/supabase.js"

/**
 * VERIFY SUPABASE JWT + LOAD USER PROFILE
 */
export const verifyToken = async (req, res, next) => {

  const supabase = getSupabase()

  try {

    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid authorization header"
      })
    }

    const token = authHeader.split(" ")[1]

    /**
     * 1. Verify JWT
     */
    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired token"
      })
    }

    const authUser = data.user

    /**
     * 2. Fetch user profile from app_users
     */
    const { data: profile, error: profileError } = await supabase
      .from("app_users")
      .select(`
        id,
        laboratory_id,
        role,
        laboratories(name)
      `)
      .eq("id", authUser.id)
      .single()

    if (profileError || !profile) {
      return res.status(403).json({
        error: "User profile not found"
      })
    }

    if (!profile.laboratory_id) {
      return res.status(403).json({
        error: "User not assigned to a laboratory"
      })
    }

    /**
     * 3. Inject user into request
     */
    req.user = {
      id: authUser.id,
      email: authUser.email,
      laboratory_id: profile.laboratory_id,
      role: profile.role,
      laboratory_name: profile.laboratories?.name
    }

    next()

  } catch (err) {

    console.error("Auth middleware error:", err)

    return res.status(500).json({
      error: "Authentication failed"
    })

  }

}