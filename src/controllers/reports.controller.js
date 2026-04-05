import { generateReport } from "../services/reports.service.js";

/**
 * GET /api/reports?period=weekly|monthly&start=YYYY-MM-DD&end=YYYY-MM-DD
 */
export const getReport = async (req, res) => {
  const labId  = req.user.laboratory_id ?? null;
  const { period = "monthly", start, end } = req.query;

  if (!["weekly", "monthly", "custom"].includes(period)) {
    return res.status(400).json({ error: "period must be weekly, monthly, or custom" });
  }
  if (period === "custom" && (!start || !end)) {
    return res.status(400).json({ error: "custom period requires start and end dates" });
  }

  try {
    const report = await generateReport(labId, period, start, end);
    return res.json(report);
  } catch (err) {
    console.error("getReport error:", err);
    return res.status(500).json({ error: err.message });
  }
};