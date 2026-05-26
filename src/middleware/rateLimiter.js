import rateLimit from 'express-rate-limit'

/**
 * Applied globally — 200 requests / IP / minute.
 * High enough not to affect normal users, low enough to blunt bots.
 */
export const globalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — please try again in a moment.' },
})

/**
 * Applied to auth endpoints only — 20 attempts / IP / 15 minutes.
 * Prevents brute-force login attacks while still allowing legitimate
 * token refreshes.
 */
export const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many authentication attempts — please wait 15 minutes.' },
})
