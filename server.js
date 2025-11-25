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

// CORS: local dev + production frontend
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://audioremoveio.vercel.app"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Detect directories: local or cloud
const LOCAL_UPLOAD_DIR = "./uploads";
const LOCAL_OUTPUT_DIR = "./converted";
const TMP_UPLOAD_DIR = "/tmp/uploads";
const TMP_OUTPUT_DIR = "/tmp/converted";

const UPLOAD_DIR = fs.existsSync(LOCAL_UPLOAD_DIR) ? LOCAL_UPLOAD_DIR : TMP_UPLOAD_DIR;
const OUTPUT_DIR = fs.existsSync(LOCAL_OUTPUT_DIR) ? LOCAL_OUTPUT_DIR : TMP_OUTPUT_DIR;

// Ensure directories exist
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer setup
const upload = multer({ dest: UPLOAD_DIR });

// POST route
app.post("/extract-audio", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}`;
  let outputExt = "m4a"; // default

  try {
    // Probe video for audio stream
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

    // Determine output extension based on codec
    const codec = audioStream.codec_name;
    if (codec === "aac") outputExt = "m4a";
    else if (codec === "mp3") outputExt = "mp3";
    else if (codec === "opus") outputExt = "opus";
    else if (codec === "vorbis") outputExt = "ogg";
    else outputExt = "mka"; // fallback

    const outputPath = path.join(OUTPUT_DIR, `${outputName}.${outputExt}`);

    // Extract audio
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("copy")
      .on("end", () => {
        res.download(outputPath, () => {
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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
