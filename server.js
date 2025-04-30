const dotenv = require("dotenv");
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const app = express();
const PORT = process.env.PORT || 3000;
const cfg = dotenv.config({ path: "./.env" });
let imgList = null;
let imgWithMimeList = null;
let cachedImageBuffers = {};   // key: fileId, value: Buffer

const getData = (fileId) => getImgData(fileId);

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

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : cfg;
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
async function listDriveImages(forceRefresh = false) {
  // If not forcing refresh and cache is still valid, return cached list
  if (!forceRefresh && Date.now() - driveCache.ts < 10 * 60_000) {
    return driveCache.list;
  }

  try {
    const res = await drive.files.list({
      q: `mimeType contains 'image/' or mimeType = 'video/mp4'`, // Include MP4 files
      fields: "files(id,name,mimeType)",
    });

    // Update the cache with the new data
    const urls = res.data.files.map((f) => f.id);

    imgWithMimeList = res.data.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
    }));

    driveCache = { ts: Date.now(), list: urls };
    return urls;
  } catch (e) {
    console.error("❌ Error fetching files from Google Drive:", e.message);
    return [];
  }
}

/* serve the list as JSON */
app.get("/images.json", async (_, res) => {
  try {
    await listDriveImages();
    res.json(imgWithMimeList);
  } catch (e) {
    console.error("Drive error:", e);
    res.status(500).json({ error: "Drive fetch failed" });
  }
});

app.get("/api/pgdrive-image", async (req, res) => {

  const fileId = req.query.fileId;

  if (!fileId) return res.status(400).send("Missing fileId");

  mimeType = getImgData(fileId)?.mimeType;
  
  const jpgBuffer = await getResizedJPEG(fileId, mimeType);

  if (!jpgBuffer) return res.status(404).send("Image not found");

  res.setHeader("Content-Type", "image/jpeg");

  return res.send(jpgBuffer);
});

app.get("/api/pgdrive-video", async (req, res) => {
  const fileId = req.query.fileId;

  if (!fileId) return res.status(400).send("Missing fileId");

  const fileData = getImgData(fileId);
  if (!fileData || fileData.mimeType !== "video/mp4") {
    return res.status(404).send("Video not found");
  }

  const videoBuffer = cachedImageBuffers[fileId];
  if (!videoBuffer) {
    return res.status(404).send("Video not preloaded");
  }

  res.setHeader("Content-Type", "video/mp4");
  return res.send(videoBuffer);
});


/* keep Render / Heroku awake */
setInterval(() => {
  fetch(`https://lovebackend.onrender.com/keepalive`);
}, 45_000);

// Cached image buffer: cachedImageBuffers[fileId] = <Buffer>
async function getResizedJPEG(fileId, mimeType) {
  let buffer;
  try{

    if (cachedImageBuffers[fileId]) return cachedImageBuffers[fileId];

    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );

    buffer = Buffer.from(res.data);
    
    // 🧠 Convert HEIF/HEIC to JPEG buffer first
    if (mimeType === "image/heif" || mimeType === "image/heic") {
      buffer = await heicConvert({
        buffer,
        format: "JPEG",
        quality: 0.9
      });
      console.log(`✅ Converted HEIC to JPEG: ${getData(fileId).name}`);
    }

    const outputBuffer = await sharp(buffer)
    .resize(800, 1200, {
      fit: "cover",
      position: "center",
    })
    .jpeg({ quality: 80 }) // optional: adjust compression
    .toBuffer();
    
    cachedImageBuffers[fileId] = outputBuffer; // cache the buffer

    return outputBuffer;

  }catch (e) {
    console.error(`Error fetching image: ${getData(fileId).name}\n${e.message}`);
    return null;
  }
}

function getImgData(fileId) {
  const file = imgWithMimeList.find(f => f.id === fileId);
  if (!file) return null;
  const { id, mimeType, name } = file;
  return { fileId: id, mimeType, name };
}
async function checkForNewImages() {
  try {
    // Force refresh to get the latest list of files (images and videos)
    const currentFileIds = await listDriveImages(true); // Pass true to bypass cache
    const cachedFileIds = Object.keys(cachedImageBuffers); // Get the cached file IDs

    // Find new file IDs that are not in the cache
    const newFileIds = currentFileIds.filter((fileId) => !cachedFileIds.includes(fileId));

    // Find removed file IDs that are in the cache but not in the current list
    const removedFileIds = cachedFileIds.filter((fileId) => !currentFileIds.includes(fileId));

    // Preload new files (images and videos)
    if (newFileIds.length > 0) {
      console.log(`🔍 Found ${newFileIds.length} new file(s). Preloading...`);

      const preloadTasks = newFileIds.map(async (fileId) => {
        try {
          const fileData = getImgData(fileId);
          if (!fileData) return;

          const { mimeType } = fileData;

          const res = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "arraybuffer" }
          );
          let buffer = Buffer.from(res.data);

          if (mimeType.startsWith("image/")) {
            // Convert HEIC/HEIF to JPEG if needed
            if (mimeType === "image/heif" || mimeType === "image/heic") {
              buffer = await heicConvert({
                buffer,
                format: "JPEG",
                quality: 0.9,
              });
              console.log(`✅ Pre-converted HEIC to JPEG: ${fileData.name}`);
            }

            // Resize and cache the image
            cachedImageBuffers[fileId] = await sharp(buffer)
              .resize(800, 1200, {
                fit: "cover",
                position: "center",
              })
              .jpeg({ quality: 80 })
              .toBuffer();

            console.log(`✅ Preloaded image: ${fileData.name}`);
          } else if (mimeType === "video/mp4") {
            // Cache MP4 files directly
            cachedImageBuffers[fileId] = buffer;
            console.log(`✅ Preloaded video: ${fileData.name}`);
          }
        } catch (e) {
          console.warn(`❌ Failed to preload file ${getData(fileId)?.name}`, e.message);
        }
      });

      await Promise.all(preloadTasks); // Wait for all preload tasks to complete
      console.log("🎉 Finished preloading new files.");
    } else {
      console.log("🔍 No new files found.");
    }

    // Remove deleted files from the cache
    if (removedFileIds.length > 0) {
      console.log(`🗑️ Found ${removedFileIds.length} removed file(s). Cleaning up...`);

      removedFileIds.forEach((fileId) => {
        delete cachedImageBuffers[fileId]; // Remove from the buffer cache
        const index = imgWithMimeList.findIndex((img) => img.id === fileId);
        if (index !== -1) {
          console.log(`🗑️ Removed file from cache: ${imgWithMimeList[index].name}`);
          imgWithMimeList.splice(index, 1); // Remove from the mime list
        }
      });

      console.log("🗑️ Finished cleaning up removed files.");
    }
  } catch (e) {
    console.error("❌ Error checking for new files:", e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Server running`);

});

// Run the initial check for new images in the background
(async () => {
  try {
    await checkForNewImages();
  } catch (e) {
    console.error("❌ Error during initial check for new files:", e.message);
  }
})();

// Periodically check for new images every 5 seconds without blocking the main thread
setInterval(async () => {
  try {
    await checkForNewImages();
  } catch (e) {
    console.error("❌ Error during periodic check for new files:", e.message);
  }
}, 5_000);