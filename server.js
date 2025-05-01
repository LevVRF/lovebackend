const express = require("express");
const fs = require("fs");
const cors = require("cors");
const { google } = require("googleapis");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const path = require("path");
const { Readable } = require("stream");
const compression = require("compression");
const dotenv = require("dotenv");
const { pipeline } = require("stream/promises");
const ffmpeg = require("fluent-ffmpeg");
const tmp = require("tmp");
const os = require("os");
const app = express();

dotenv.config({ path: "./.env" });

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

const FOLDER_NAME = "Photos";
const TRASH_FOLDER_NAME = "Trash";

app.use(cors());
app.use(compression({ threshold: 0 }));
app.use(express.json());

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.JWT(
  key.client_email,
  null,
  key.private_key,
  ["https://www.googleapis.com/auth/drive"]
);
const drive = google.drive({ version: "v3", auth });

let settings = require("./settings.json");

// 🔁 KEEPALIVE ENDPOINT
app.get("/keepalive", (req, res) => res.send("pong"));

// ⚙️ SETTINGS ENDPOINTS
app.get("/settings", (req, res) => res.json(settings));
app.post("/settings", (req, res) => {
  settings = req.body;
  fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
  res.json({ success: true });
});

// 📁 Get folder ID by name
async function getFolderIdByName(name) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });
  return res.data.files[0]?.id;
}

// 📄 List all media in Photos folder
async function listAllMediaFiles() {
  const folderId = await getFolderIdByName(FOLDER_NAME);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name, mimeType)",
    pageSize: 1000,
  });
  return res.data.files;
}

// 📄 List only files that are not .jpg and not already resized
async function listNonJpgFiles() {
  const all = await listAllMediaFiles();
  return all.filter(f => {
    const name = f.name.toLowerCase();
    return !name.endsWith(".jpg") && !name.includes("_resized");
  });
}

// 📤 Convert HEIC ➜ JPEG and move original to Trash
async function convertAndUploadHEIC(file) {
  const fileId = file.id;
  const fileName = path.parse(file.name).name + ".jpg";
  console.log(`🖼️ Starting Image resizing & uploading: ${fileName}`);
  const folderId = await getFolderIdByName(FOLDER_NAME);
  const trashFolderId = await getFolderIdByName(TRASH_FOLDER_NAME);

  const dest = [];
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  res.data.on("data", chunk => dest.push(chunk));

  return new Promise((resolve, reject) => {
    res.data.on("end", async () => {
      try {
        const inputBuffer = Buffer.concat(dest);

        // 🔄 HEIC ➜ JPEG
        const jpegBuffer = await heicConvert({
          buffer: inputBuffer,
          format: "JPEG",
          quality: 1,
        });

        // 🔧 Resize to 800x1200
        const resizedBuffer = await sharp(jpegBuffer)
          .resize({ width: 800, height: 1200, fit: "inside" })
          .jpeg({ quality: 100 })
          .toBuffer();

        // ☁️ Upload to Drive
        const media = {
          mimeType: "image/jpeg",
          body: Readable.from(resizedBuffer),
        };

        const metadata = {
          name: fileName,
          parents: [folderId],
        };

        const upload = await drive.files.create({
          resource: metadata,
          media: media,
          fields: "id",
        });

        // 🗑 Move original to Trash folder
        await drive.files.update({
          fileId,
          addParents: trashFolderId,
          removeParents: folderId,
          fields: "id, parents",
        });

        console.log(`✅ Converted & Resized: ${file.name} → ${fileName}`);
        resolve(upload.data.id);
      } catch (err) {
        console.error(`❌ Failed to convert: ${file.name}`, err);
        reject(err);
      }
    });

    res.data.on("error", reject);
  });
}

// 📹 Resize video to 800x1200 and upload
async function resizeAndUploadVideo(file) {
  
  const fileId = file.id;
  const fileName = path.parse(file.name).name + "_resized.mp4";
  console.log(`📹 Starting Video resizing & uploading: ${fileName}`);
  const folderId = await getFolderIdByName(FOLDER_NAME);
  const trashFolderId = await getFolderIdByName(TRASH_FOLDER_NAME);

  // Step 1: Download video from Drive
  const videoChunks = [];
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  res.data.on("data", chunk => videoChunks.push(chunk));

  return new Promise((resolve, reject) => {
    res.data.on("end", async () => {
      try {
        const inputBuffer = Buffer.concat(videoChunks);
        const tmpInput = tmp.tmpNameSync({ postfix: ".mp4" });
        const tmpOutput = tmp.tmpNameSync({ postfix: ".mp4" });

        fs.writeFileSync(tmpInput, inputBuffer);

        // Step 2: Resize with FFmpeg
        ffmpeg(tmpInput)
          .outputOptions([
            "-vf", "scale=800:1200:force_original_aspect_ratio=decrease,pad=800:1200:(ow-iw)/2:(oh-ih)/2",
            "-preset", "fast",
            "-movflags", "frag_keyframe+empty_moov"
          ])
          .on("end", async () => {
            const media = {
              mimeType: "video/mp4",
              body: fs.createReadStream(tmpOutput),
            };

            const metadata = {
              name: fileName,
              parents: [folderId],
            };

            // 🗑 Move original to Trash folder
            await drive.files.update({
              fileId,
              addParents: trashFolderId,
              removeParents: folderId,
              fields: "id, parents",
            });

            const upload = await drive.files.create({
              resource: metadata,
              media: media,
              fields: "id",
            });


            console.log(`📹 Video resized & uploaded: ${fileName}`);
            fs.unlinkSync(tmpInput);
            fs.unlinkSync(tmpOutput);
            resolve(upload.data.id);
          })
          .on("error", err => {
            console.error("❌ FFmpeg error:", err);
            reject(err);
          })
          .save(tmpOutput);

      } catch (err) {
        console.error(`❌ Video conversion failed: ${file.name}`, err);
        reject(err);
      }
    });

    res.data.on("error", reject);
  });
}

// 🔄 Convert all non-JPG files
async function convertAll() {
  const files = await listNonJpgFiles();
  console.log(`🔍 Found ${files.length} non-JPG files.`);

  for (const file of files) {
    if (file.mimeType.startsWith("image/")) {
      try {
        await convertAndUploadHEIC(file);
      } catch (e) {
        console.error(`Error with ${file.name}:`, e);
      }
    }
    if (file.mimeType.startsWith("video/")) {
      try {
        await resizeAndUploadVideo(file);
      } catch (e) {
        console.error(`Error with ${file.name}:`, e);
      }
    }
  }
}

// 🔘 API to trigger conversion
app.post("/convert", async (req, res) => {
  try {
    await convertAll();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📸 Return media list
app.get("/images.json", async (req, res) => {
  try {
    const files = await listAllMediaFiles();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: "Failed to list images." });
  }
});

app.get("/api/pgdrive-image", async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).send("Missing fileId param");

  try {
    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    res.setHeader("Content-Type", "image/jpeg");
    await pipeline(driveRes.data, res);
  } catch (err) {
    console.error("❌ Streaming error:", err.message);
    if (!res.headersSent) {
      res.status(500).send("Stream error");
    } else {
      res.destroy(); // Optional: force close if already sent
    }
  }
});

// 📹 Serve video by fileId
app.get("/api/pgdrive-video", async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).send("Missing fileId param");

    const driveRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    res.setHeader("Content-Type", "video/mp4");
    driveRes.data
    .on("error", (err) => {
      console.error("❌ Streaming error:", err.message);
      if (!res.headersSent) {
        res.status(500).send("Stream error");
      }
    })
    .pipe(res);;
  } catch (err) {
    res.status(500).send("Failed to stream video");
  }
});

setInterval(() => {
  // 🔁 Keepalive
  fetch(`${SELF_URL}/keepalive`)
    .then(() => console.log("🫀 Keepalive ping"))
    .catch(err => console.warn("⚠️ Keepalive failed:", err));

  // ♻️ Convert all HEIC files
  fetch(`${SELF_URL}/convert`, { method: "POST" })
    .then(res => res.json())
    .then(data => {
      if (data.success) console.log("🖼️ HEIC conversion done.");
      else console.warn("⚠️ Conversion error:", data);
    })
    .catch(err => console.error("❌ Conversion failed:", err));
}, 5 * 60 * 1000); // every 5 minutes


app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  convertAll()
    .then(() => console.log("🖼️ Initial conversion done."))
    .catch(err => console.error("❌ Initial conversion failed:", err));
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("💥 Unhandled Rejection:", err);
});
