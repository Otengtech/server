import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpeg from "fluent-ffmpeg";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

app.use(cors({ origin: process.env.CLIENT_URL, }));

const upload = multer({ dest: "uploads/" });
const OUTPUT_DIR = "./converted";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function getCodec(format) {
  switch (format) {
    case "mp3": return "libmp3lame";
    case "aac": return "aac";
    case "wav": return "pcm_s16le";
    case "ogg": return "libvorbis";
    default: return null;
  }
}

function getSecondsFromTime(timeString) {
  if (!timeString) return 0;
  const parts = timeString.split(':');
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
}

app.post("/extract-audio", upload.single("video"), async (req, res) => {
  const { format = "mp3", bitrate = "128k" } = req.body;

  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}.${format}`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  let duration = 0;
  try {
    duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        if (err) reject(err);
        else resolve(data.format.duration);
      });
    });
  } catch (err) {
    console.error("FFprobe failed:", err);
  }

  const codec = getCodec(format);

  res.setHeader("Content-Type", "application/octet-stream");

  // Fast extraction using copy if
  const command = ffmpeg(inputPath).noVideo();

  // Try copy first (super fast)
  command.audioCodec("copy");

  // Fallback to re-encode if codec is required
  if (codec) command.audioCodec(codec).audioBitrate(bitrate);

  let lastPercent = 0; // to control update jumps

  command
    .outputOptions("-threads 0")
    .on("start", (cmd) => console.log("FFmpeg START:", cmd))
    .on("progress", (data) => {
      if (!data.timemark || !duration) return;
      let current = getSecondsFromTime(data.timemark);
      let percent = Math.floor((current / duration) * 100);

      // Only send updates if percent jumped at least 5% (adjust as needed)
      if (percent - lastPercent >= 5 || percent === 100) {
        console.log(`Progress: ${percent}%`);
        lastPercent = percent;
        // Optionally: you can send percent to frontend via SSE or WebSocket
      }
    })
    .on("end", () => {
      console.log("DONE!");
      res.download(outputPath, () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      });
    })
    .on("error", (err) => {
      console.error("FFmpeg ERROR:", err.message);
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      res.status(500).json({ error: "Conversion failed" });
    })
    .save(outputPath);
});

app.listen(3001, () => console.log("Server running on port 3001"));
