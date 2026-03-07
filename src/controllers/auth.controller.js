import { getSupabase } from "../config/supabase.js";

const supabase = getSupabase();

export const registerUser = async (req, res) => {
  try {
    const { email, password, laboratory_id, role } = req.body;

    /**
     * Validate input
     */
    if (!email || !password || !laboratory_id || !role) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    /**
     * Register user in Supabase Auth
     */
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          laboratory_id,
          role
        }
      }
    });

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(201).json({
      message: "User registered successfully",
      user: data?.user ?? null
    });

  } catch (err) {
    console.error("Registration error:", err);

    return res.status(500).json({
      error: "Registration failed"
    });
  }
};