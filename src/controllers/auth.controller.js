import { supabase } from '../config/supabase.js'

export const registerUser = async (req, res) => {
  try {
    const { email, password, laboratory_id, role } = req.body

    if (!email || !password || !laboratory_id || !role) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          laboratory_id,
          role
        }
      }
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    return res.status(201).json({
      message: 'User registered successfully',
      user: data.user
    })

  } catch (err) {
    return res.status(500).json({ error: 'Registration failed' })
  }
}