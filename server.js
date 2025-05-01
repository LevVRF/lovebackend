const dotenv = require("dotenv");
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const NodeCache = require("node-cache");
const videoCache = new NodeCache({ stdTTL: 60 * 10, checkperiod: 60 * 5 }); // Cache for 10 minutes
const compression = require("compression");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
dotenv.config({ path: "./.env" });

app.use(cors());
app.use(express.json());
app.use(compression()); // Enable compression for responses

// Google Drive setup
const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const drive = google.drive({
  version: "v3",
  auth: new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ["https://www.googleapis.com/auth/drive.readonly"]
  ),
});

// Cache for file metadata (refreshed every 10 minutes)
let imgWithMimeList = null;
let driveCache = { ts: 0, list: [] };

// Utility to log messages
const isProduction = process.env.NODE_ENV === "production";
function log(level, message) {
  if (isProduction && level === "debug") return;
  console[level](`[${level.toUpperCase()}] ${message}`);
}

// 🔍 GET /settings - returns settings.json
app.get("/settings", (req, res) => {
  fs.readFile("settings.json", "utf8", (err, data) => {
    if (err) {
      log("error", "❌ Error reading settings.json:", err);
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
      log("error", `❌ Error writing settings.json: ${err.message}`);
      return res.status(500).json({ error: "Failed to save settings" });
    }
    res.json({ success: true });
    log("info", "✅ Updated Settings file ");
  });
});

// Fetch file metadata from Google Drive
async function listDriveImages(forceRefresh = false) {
  if (!forceRefresh && Date.now() - driveCache.ts < 10 * 60_000) {
    return driveCache.list;
  }

  try {
    const res = await drive.files.list({
      q: `mimeType contains 'image/' or mimeType = 'video/mp4'`,
      fields: "files(id,name,mimeType,size)",
    });

    imgWithMimeList = res.data.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size || 0,
    }));

    driveCache = { ts: Date.now(), list: imgWithMimeList.map((f) => f.id) };
    return driveCache.list;
  } catch (e) {
    log("error", `❌ Error fetching files from Google Drive: ${e.message}`);
    return [];
  }
}

// Get file metadata by ID
function getImgData(fileId) {
  if (!imgWithMimeList) return null;
  return imgWithMimeList.find((f) => f.id === fileId) || null;
}

// Retry mechanism for transient errors
async function fetchWithRetry(fetchFn, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchFn();
    } catch (e) {
      if (attempt < retries) {
        log("warn", `⚠️ Retry ${attempt} after error: ${e.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw e;
      }
    }
  }
}

async function convertHeicToJpegNative(buffer, fileName) {
  try {
    const jpegBuffer = await heicConvert({
      buffer, // Input HEIC buffer
      format: "JPEG", // Output format
      quality: 1, // Quality (1 = best)
    });

    log("info", `✅ Converted HEIC to JPEG using heic-convert: ${fileName}`);
    return jpegBuffer;
  } catch (e) {
    log("error", `❌ Error converting HEIC to JPEG using heic-convert: ${fileName} - ${e.message}`);
    throw e;
  }
}
// Stream-based HEIC to JPEG conversion
async function convertHeicToJpegStream(fileId, fileName) {
  try {
    const driveResponse = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    const jpegStream = sharp()

    log("info", `🔄 Converting HEIC to JPEG: ${fileName}`);
    return driveResponse.data.pipe(jpegStream);
  } catch (e) {
    log("error", `❌ Error converting HEIC to JPEG: ${fileName} - ${e.message}`);
    throw e;
  }
}

// Serve images on demand
app.get("/api/pgdrive-image", async (req, res) => {
  const fileId = req.query.fileId;

  if (!fileId) return res.status(400).send("Missing fileId");

  const fileData = getImgData(fileId);
  if (!fileData || !fileData.mimeType.startsWith("image/")) {
    return res.status(404).send("Image not found");
  }

  try {
    if (fileData.mimeType === "image/heic" || fileData.mimeType === "image/heif") {
      // Fetch the HEIC file from Google Drive
      const driveResponse = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );

      const heicBuffer = Buffer.from(driveResponse.data);

      // Convert HEIC to JPEG
      const jpegBuffer = await convertHeicToJpegNative(heicBuffer, fileData.name);

      // Send the converted JPEG
      res.setHeader("Content-Type", "image/jpeg");
      return res.end(jpegBuffer);
    } else {
      const driveResponse = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );
      res.setHeader("Content-Type", fileData.mimeType);
      driveResponse.data.pipe(res); // Stream the original image directly
    }
  } catch (e) {
    log("error", `❌ Error fetching image ${fileId}: ${e.message}`);
    res.status(500).send("Failed to fetch image");
  }
});

app.get("/api/pgdrive-video", async (req, res) => {
  const fileId = req.query.fileId;

  if (!fileId) return res.status(400).send("Missing fileId");

  const fileData = getImgData(fileId);
  if (!fileData || fileData.mimeType !== "video/mp4") {
    return res.status(404).send("Video not found");
  }

  try {
    const range = req.headers.range;
    if (!range) {
      // If no range header, send the entire video
      log("info", `No range header, streaming entire video: ${fileData.name}`);
      const cachedVideo = videoCache.get(fileId);

      if (cachedVideo) {
        log("info", `Serving video from cache: ${fileData.name}`);
        res.setHeader("Content-Type", "video/mp4");
        return res.end(cachedVideo);
      }

      const driveResponse = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );

      const videoBuffer = Buffer.from(driveResponse.data);
      videoCache.set(fileId, videoBuffer); // Cache the video
      res.setHeader("Content-Type", "video/mp4");
      return res.end(videoBuffer);
    }

    // Parse the range header
    const videoSize = parseInt(fileData.size, 10); // Replace with actual video size
    const CHUNK_SIZE = 10 ** 6; // 1MB per chunk
    const start = Number(range.replace(/\D/g, ""));
    const end = Math.min(start + CHUNK_SIZE - 1, videoSize - 1);

    log("info", `Streaming range ${start}-${end} for video: ${fileData.name}`);

    // Set headers for partial content
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });

    // Fetch the requested chunk from Google Drive
    const driveResponse = await drive.files.get(
      { fileId, alt: "media" },
      {
        headers: { Range: `bytes=${start}-${end}` },
        responseType: "stream",
      }
    );

    // Stream the requested chunk
    driveResponse.data.pipe(res);
  } catch (e) {
    log("error", `❌ Error fetching video ${fileId}: ${e.message}`);
    res.status(500).send("Failed to fetch video");
  }
});

// Serve file metadata as JSON
app.get("/images.json", async (_, res) => {
  try {
    await listDriveImages();
    res.json(imgWithMimeList);
  } catch (e) {
    log("error", `❌ Drive error: ${e.message}`);
    res.status(500).json({ error: "Drive fetch failed" });
  }
});

// Keep Heroku/Render awake
setInterval(() => {
  fetch(`https://lovebackend.onrender.com/keepalive`);
}, 45_000);

// Start the server
app.listen(PORT, () => {
  log("info", `🚀 Server running on port ${PORT}`);
});