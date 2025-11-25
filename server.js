import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpeg from "fluent-ffmpeg";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

// FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// FIXED CORS — allows local dev and production client
app.use(cors({
  origin: ["http://localhost:5173", process.env.CLIENT_URL],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Upload setup
const upload = multer({ dest: "uploads/" });

// Ensure output dir exists
const OUTPUT_DIR = "./converted";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// POST ROUTE
app.post("/extract-audio", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}`;
  let outputExt = "m4a"; // default

  try {
    // Probe video to detect audio codec
    const probeData = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const audioStream = probeData.streams.find(s => s.codec_type === "audio");
    if (!audioStream) {
      fs.unlinkSync(inputPath);
      return res.status(400).json({ error: "No audio track found" });
    }

    // Choose extension automatically
    const codec = audioStream.codec_name;
    if (codec === "aac") outputExt = "m4a";
    else if (codec === "mp3") outputExt = "mp3";
    else if (codec === "opus") outputExt = "opus";
    else if (codec === "vorbis") outputExt = "ogg";
    else outputExt = "mka"; // fallback container for unknown codecs

    const outputPath = path.join(OUTPUT_DIR, `${outputName}.${outputExt}`);

    // SUPER FAST extraction
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("copy")
      .on("end", () => {
        // Send file to client
        res.download(outputPath, () => {
          // Cleanup after download
          if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg ERROR:", err.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        res.status(500).json({ error: "Extraction failed" });
      })
      .save(outputPath);

  } catch (err) {
    console.error("FFprobe ERROR:", err);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    res.status(500).json({ error: "FFprobe error" });
  }
});

// Start server
app.listen(3001, () => console.log("Server running on port 3001"));
