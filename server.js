const dotenv = require("dotenv");
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const app = express();
const pLimit = require("p-limit").default;
const compression = require("compression");



const PORT = process.env.PORT || 3000;
const cfg = dotenv.config({ path: "./.env" });


const limit = pLimit(5); // 5 concurrent downloads
let runningPreload = false; // Flag to prevent multiple concurrent checks
let imgList = null;
let imgWithMimeList = null;
let cachedImageBuffers = {};   // key: fileId, value: Buffer

const getData = (fileId) => getImgData(fileId);

app.use(cors());
app.use(express.json()); // to parse JSON bodies
app.use(compression());

// 🔍 GET /keepalive - does nothing
app.get("/keepalive", (req, res) => {  
  res.send("pong");
});

// 🔍 GET /settings - returns settings.json
app.get("/settings", (req, res) => {
  fs.readFile("settings.json", "utf8", (err, data) => {
    if (err) {
      error("❌ Error reading settings.json:", err);
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
      error("❌ Error writing settings.json:", err);
      return res.status(500).json({ error: "Failed to save settings" });
    }
    res.json({ success: true });
    console.info("✅ Updated Settings file ");
  });
});

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}


const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
log(key.client_email);
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
  if (!forceRefresh && Date.now() - driveCache.ts < 10 * 60_000) {
    return driveCache.list;
  }

  try {
    const res = await drive.files.list({
      q: `mimeType contains 'image/' or mimeType = 'video/mp4'`,
      fields: "files(id,name,mimeType)",
    });

    imgWithMimeList = res.data.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      timestamp: Date.now(), // Add timestamp for cache eviction
    }));

    driveCache = { ts: Date.now(), list: imgWithMimeList.map((f) => f.id) };
    return driveCache.list;
  } catch (e) {
    error("❌ Error fetching files from Google Drive:", e.message);
    return [];
  }
}

/* serve the list as JSON */
app.get("/images.json", async (_, res) => {
  try {
    await listDriveImages();
    res.json(imgWithMimeList);
  } catch (e) {
    error("Drive error:", e);
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
      log(`✅ Converted HEIC to JPEG: ${getData(fileId).name}`);
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
    error(`Error fetching image: ${getData(fileId).name}\n${e.message}`);
    return null;
  }
}

function getImgData(fileId) {

  if (!imgWithMimeList) return null;

  const file = imgWithMimeList.find(f => f.id === fileId);
  if (!file) return null;
  const { id, mimeType, name } = file;
  return { fileId: id, mimeType, name };

}
// Utility to fetch file data from Google Drive
async function fetchFileData(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

// Convert HEIC/HEIF to JPEG
async function convertHeicToJpeg(fileId, buffer, fileName) {
  return new Promise((resolve, reject) => {
    setImmediate(async () => {
      try {
        const jpegBuffer = await heicConvert({
          buffer,
          format: "JPEG",
          quality: 0.9,
        });
        log(`✅ Converted HEIC to JPEG: ${fileName}`);        
        await resizeAndCacheImage(fileId, jpegBuffer, fileName);
        resolve(jpegBuffer);
      } catch (e) {
        error(`❌ Error converting HEIC to JPEG: ${fileName}`, e.message);
        reject(e);
      }
    });
  });
}

// Resize and cache an image
async function resizeAndCacheImage(fileId, buffer, fileName) {
  if (cachedImageBuffers[fileId]) {
    log(`ℹ️ Image already cached: ${fileName}`);
    return;
  }
  try {
    const resizedBuffer = await sharp(buffer)
      .resize(800, 1200, { fit: "cover", position: "center" })
      .jpeg({ quality: 80 })
      .toBuffer();
    cachedImageBuffers[fileId] = resizedBuffer;
    log(`✅ Preloaded image: ${fileName}`);
  } catch (e) {
    error(`❌ Error resizing image: ${fileName}`, e.message);
    throw e;
  }
}

// Cache MP4 files directly
function cacheVideo(fileId, buffer, fileName) {
  cachedImageBuffers[fileId] = buffer;
  log(`✅ Preloaded video: ${fileName}`);
}

// Process a single file (image or video)
async function processFile(fileId) {
  try {
    const fileData = getImgData(fileId);
    if (!fileData) return;

    const { mimeType, name } = fileData;
    const buffer = await fetchFileData(fileId);

    if (mimeType.startsWith("image/")) {
      if (mimeType === "image/heif" || mimeType === "image/heic") {
        (async () => {
          convertHeicToJpeg(fileId,buffer, name);
        })();
      } else {
        (async () => {
          await resizeAndCacheImage(fileId, buffer, name);
        })();
      }
    } else if (mimeType === "video/mp4") {
      cacheVideo(fileId, buffer, name);
    }
  } catch (e) {
    console.warn(`❌ Failed to process file ${fileId}:`, e.message);
  }
}

// Remove deleted files from the cache
function removeDeletedFiles(removedFileIds) {
  log("🗑️ Cleaning up removed files...");
  removedFileIds.forEach((fileId) => {
    delete cachedImageBuffers[fileId];
    const index = imgWithMimeList.findIndex((img) => img.id === fileId);
    if (index !== -1) {
      log(`🗑️ Removed file from cache: ${imgWithMimeList[index].name}`);
      imgWithMimeList.splice(index, 1);
    }
  });
  log("🗑️ Finished cleaning up removed files.");
}

// Check for new and removed files
async function checkForNewImages() {
  try {
    if (runningPreload) return; // Prevent multiple concurrent checks
    log("🔍 Checking for new and removed files...");

    const currentFileIds = await listDriveImages(true);
    const cachedFileIds = Object.keys(cachedImageBuffers);

    const newFileIds = currentFileIds.filter((fileId) => !cachedFileIds.includes(fileId));
    const removedFileIds = cachedFileIds.filter((fileId) => !currentFileIds.includes(fileId));

    log(`🔍 Found ${newFileIds.length} new file(s) and ${removedFileIds.length} removed file(s).`);

    // Sort new files by extension: jpg, png, mp4, heic
    const extensionPriority = ["jpg", "png", "mp4", "heic"];
    newFileIds.sort((a, b) => {
      const extA = getImgData(a)?.name.split(".").pop().toLowerCase();
      const extB = getImgData(b)?.name.split(".").pop().toLowerCase();
      return extensionPriority.indexOf(extA) - extensionPriority.indexOf(extB);
    });

    if (newFileIds.length > 0) {
      log("✨ Preloading new files...");
      (async () => {
        processInBatches(newFileIds, processFile);
      })();
    } else {
      log("🔍 No new files to preload.");
    }

    if (removedFileIds.length > 0) {
      removeDeletedFiles(removedFileIds);
    }
  } catch (e) {
    error("❌ Error checking for new files:", e.message);
  }
}

// Helper function to process items in batches
async function processInBatches(items, processFn) {
  runningPreload = true; // Set the flag to indicate that the preload is running
  (async () => { Promise.all(items.map(id => limit(() => processFn(id))))})();
  runningPreload = false; // Set the flag to indicate that the preload is no longer running
}

// Start the server
app.listen(PORT, () => {
  log(`🚀 Server running`);
});


(async () => {
  // Run the initial check
  checkForNewImages().catch((err) => {
    console.error("❌ Initial check failed:", err.message);
  });

  // Periodically check for new images every 5 seconds
  setInterval(() => {
    checkForNewImages().catch((err) => {
      console.error("❌ Periodic check failed:", err.message);
    });
  }, 5_000);
})(); // Immediately invoked function to start the preload process
