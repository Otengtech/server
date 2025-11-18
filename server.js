import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

app.use(cors({ origin: process.env.CLIENT_URL }));

const upload = multer({ dest: "uploads/" });
const OUTPUT_DIR = "./converted";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// ONLY choose formats that support codec copy
const validFormats = ["mp3", "aac", "m4a", "ogg"];

app.post("/extract-audio", upload.single("video"), (req, res) => {
  const { format = "mp3" } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded" });
  }

  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: "Unsupported fast format" });
  }

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}.${format}`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  res.setHeader("Content-Type", "application/octet-stream");

  const command = ffmpeg(inputPath)
    .noVideo()

    // 🔥 Fastest possible audio extraction (no re-encoding)
    .audioCodec("copy")

    // 🔥 Use all CPU threads
    .outputOptions("-threads 0")
    .outputOptions("-preset ultrafast")

    .on("start", cmd => console.log("FFmpeg START:", cmd))
    .on("progress", progress => {
      console.log("Time:", progress.timemark || "N/A");
    })
    .on("end", () => {
      console.log("DONE!");
      res.download(outputPath, () => {
        fs.existsSync(outputPath) && fs.unlinkSync(outputPath);
        fs.existsSync(inputPath) && fs.unlinkSync(inputPath);
      });
    })
    .on("error", err => {
      console.error("FFmpeg ERROR:", err.message);
      fs.existsSync(inputPath) && fs.unlinkSync(inputPath);
      res.status(500).json({ error: "Conversion failed" });
    });

  command.save(outputPath);
});

app.listen(3001, () => console.log("Server running on port 3001"));
