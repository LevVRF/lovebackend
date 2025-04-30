const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const sharp = require("sharp");
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
console.log(key.client_email);
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
    imgList = await listDriveImages();
    res.json(imgList);
  } catch (e) {
    console.error("Drive error:", e);
    res.status(500).json({ error: "Drive fetch failed" });
  }
});

app.get("/api/pgdrive-image", async (req, res) => {
  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).send("Missing fileId");

  const jpgBuffer = await getResizedJPEG(fileId);
  if (!jpgBuffer) return res.status(404).send("Image not found");
  res.setHeader("Content-Type", "image/jpeg");
  return res.send(jpgBuffer);
  // if (cachedImageBuffers[fileId]) {
  //   console.log("✅ Cache hit for", fileId);
  //   res.type("image/jpeg"); // or detect mime
  //   return res.send(cachedImageBuffers[fileId]);
  // }

  // try {
  //   console.log("🔄 Cache miss for", fileId);
  //   const driveRes = await drive.files.get(
  //     { fileId, alt: "media" },
  //     { responseType: "stream" }
  //   );
  //   console.log("✅ Fetched from Drive", fileId);
  //   res.setHeader("Content-Type", driveRes.headers["content-type"]);
  //   res.type("image/jpeg"); // or detect mime
  //   driveRes.data.pipe(res);
  //   cachedImageBuffers[fileId] = Buffer.from(res.data);
  // } catch (e) {
  //   res.status(500).send("Failed to fetch from Drive");
  // }
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
  fetch(`https://lovebackend.onrender.com/keepalive`);
}, 45_000);

// Cached image buffer: cachedImageBuffers[fileId] = <Buffer>
async function getResizedJPEG(fileId) {
  let buffer;

  if (cachedImageBuffers[fileId]) {
    buffer = cachedImageBuffers[fileId];
  } else {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    buffer = Buffer.from(res.data);
  }

  const outputBuffer = await sharp(buffer)
    .resize(800, 1200, {
      fit: "cover",
      position: "center",
    })
    .jpeg({ quality: 80 }) // optional: adjust compression
    .toBuffer();

  return outputBuffer;
}




app.listen(PORT, async () => {
  console.log(`🚀 Server running`);  
  preloadDriveImages();
});