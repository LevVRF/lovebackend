const express = require("express");
const fs = require("fs");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // to parse JSON bodies

// 🔍 GET /keepalive - does nothing
app.get("/keepalive", (req, res) => {  
  res.send("pong");
});

// 🔍 GET /settings - returns settings.json
app.get("/settings", (req, res) => {
  fs.readFile("settings.json", "utf8", (err, data) => {
    if (err) {
      console.error("❌ Error reading settings.json:", err);
      return res.status(500).json({ error: "Failed to read settings" });
    }
    res.setHeader("Content-Type", "application/json");
    res.send(data);
    console.info("✅ Sent Settings file");
  });
});
// 💾 POST /settings - overwrites settings.json
app.post("/settings", (req, res) => {
  fs.writeFile("settings.json", JSON.stringify(req.body, null, 2), "utf8", (err) => {
    if (err) {
      console.error("❌ Error writing settings.json:", err);
      return res.status(500).json({ error: "Failed to save settings" });
    }
    res.json({ success: true });
    console.info("✅ Updated Settings file ");
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running`);
});
