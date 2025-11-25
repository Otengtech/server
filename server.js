import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

// FFmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// CORS
app.use(cors({
  origin: ["https://audioremoveio.vercel.app", process.env.CLIENT_URL],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Use /tmp folder for cloud-friendly uploads
const TMP_UPLOAD_DIR = "/tmp/uploads";
const TMP_OUTPUT_DIR = "/tmp/converted";

if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_OUTPUT_DIR)) fs.mkdirSync(TMP_OUTPUT_DIR, { recursive: true });

// Multer setup
const upload = multer({ dest: TMP_UPLOAD_DIR });

// Supported formats
const FAST_FORMATS = ["mp3", "aac", "wav", "ogg", "flac"];
function getCodec(format) {
  switch (format) {
    case "mp3": return "libmp3lame";
    case "aac": return "aac";
    case "wav": return "pcm_s16le";
    case "ogg": return "libvorbis";
    case "flac": return "flac";
    default: return null;
  }
}

app.post("/extract-audio", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const { format = "mp3", bitrate = "128k" } = req.body;

  if (!FAST_FORMATS.includes(format)) {
    return res.status(400).json({ error: "Format not supported" });
  }

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}.${format}`;
  const outputPath = path.join(TMP_OUTPUT_DIR, outputName);
  const codec = getCodec(format);

  try {
    // Try fast copy first if possible
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("copy")
      .on("end", () => {
        res.download(outputPath, () => {
          cleanupFiles(inputPath, outputPath);
        });
      })
      .on("error", () => {
        // Fallback: re-encode
        ffmpeg(inputPath)
          .noVideo()
          .audioCodec(codec)
          .audioBitrate(bitrate)
          .outputOptions("-threads 0", "-preset ultrafast")
          .on("end", () => {
            res.download(outputPath, () => {
              cleanupFiles(inputPath, outputPath);
            });
          })
          .on("error", (err) => {
            console.error("Conversion ERROR:", err);
            cleanupFiles(inputPath, outputPath);
            res.status(500).json({ error: err.message });
          })
          .save(outputPath);
      })
      .save(outputPath);
  } catch (err) {
    console.error("Server ERROR:", err);
    cleanupFiles(inputPath, outputPath);
    res.status(500).json({ error: err.message });
  }
});

// Helper to remove temp files
function cleanupFiles(...files) {
  files.forEach(file => {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
