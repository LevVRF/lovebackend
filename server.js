const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const app = express();
const PORT = process.env.PORT || 3000;

let imgList = null;
let cachedImageBuffers = {};   // key: fileId, value: Buffer

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

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const drive = google.drive({
  version: "v3",
  auth: new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ["https://www.googleapis.com/auth/drive.readonly"]
  )
});

// cache list for 10 min to avoid hitting quota
let driveCache = { ts: 0, list: [] };

async function listDriveImages() {
  if (Date.now() - driveCache.ts < 10 * 60_000) return driveCache.list;

  const res = await drive.files.list({
    q: `mimeType contains 'image/'`,
    fields: "files(id,name,mimeType)"
  });

  // direct download URL pattern
  const urls = res.data.files.map(f => f.id);
  driveCache = { ts: Date.now(), list: urls };
  return urls ? urls : null;
}

/* serve the list as JSON */
app.get("/images.json", async (_, res) => {
  try {
    if (imgList == null) imgList = await listDriveImages();
    res.json(imgList);
  } catch (e) {
    console.error("Drive error:", e);
    res.status(500).json({ error: "Drive fetch failed" });
  }
});

app.get("/api/pgdrive-image", async (req, res) => {
  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).send("Missing fileId");

  if (cachedImageBuffers[fileId]) {
    res.type("image/jpeg"); // or detect mime
    return res.send(cachedImageBuffers[fileId]);
  }

  try {
    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );
    driveRes.data.pipe(res);
  } catch (e) {
    res.status(500).send("Failed to fetch from Drive");
  }
});


app.listen(PORT, async () => {
  console.log(`🚀 Server running`);  
  preloadDriveImages();
});

async function preloadDriveImages() {
  const fileIds = await listDriveImages(); // should return just the Drive file IDs

  const preloadTasks = fileIds.map(async fileId => {
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );

      cachedImageBuffers[fileId] = Buffer.from(res.data);
      console.log(`✅ Preloaded image ${fileId}`);
    } catch (e) {
      console.warn(`❌ Failed to preload ${fileId}`, e.message);
    }
  });

  await Promise.all(preloadTasks); // Wait until all are done
  console.log("🎉 All images preloaded");
}


/* keep Render / Heroku awake */
setInterval(() => {
  fetch(`https://lovebackend.onrender.com/keepalive`).catch(() => {});
  wss.clients.forEach(ws => ws.readyState === 1 && ws.ping());
}, 45_000);