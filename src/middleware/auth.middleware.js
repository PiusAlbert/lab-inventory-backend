import { getSupabase } from "../config/supabase.js";

/**
 * VERIFY SUPABASE JWT
 * - Validates token
 * - Fetches authenticated user
 * - Injects req.user
 */
export const verifyToken = async (req, res, next) => {
  const supabase = getSupabase();
  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid authorization header"
      });
    }

    const token = authHeader.split(" ")[1];

    /**
     * Verify token with Supabase
     */

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired token"
      });
    }

    const user = data.user;

    /**
     * Extract metadata
     */

    const laboratoryId = user.user_metadata?.laboratory_id;
    const role = user.user_metadata?.role;

    if (!laboratoryId || !role) {
      return res.status(403).json({
        error: "User metadata incomplete"
      });
    }

    /**
     * Inject authenticated user
     */

    req.user = {
      id: user.id,
      email: user.email,
      laboratory_id: laboratoryId,
      role: role
    };

    next();

  } catch (err) {

    console.error("Auth middleware error:", err);

    return res.status(500).json({
      error: "Authentication failed"
    });

  }
};