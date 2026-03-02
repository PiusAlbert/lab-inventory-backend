const express = require("express");
const cors = require("cors");

const categoriesRoutes = require("./routes/categories.routes");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", service: "Lab Inventory Backend" });
});

// API routes
app.use("/api/categories", categoriesRoutes);

module.exports = app;