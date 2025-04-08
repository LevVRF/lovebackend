const express = require("express");
const cors = require("cors");
const app = express();

// Allow all origins (or specify just your domain)
app.use(cors({
  origin: ["http://127.0.0.1:5500", "https://levvrf.github.io"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// Your routes...
app.get("/settings", (req, res) => {
  res.json(/* your settings object */);
});

app.post("/settings", (req, res) => {
  // Save logic here
  res.json({ success: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
