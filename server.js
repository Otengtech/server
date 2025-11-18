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

// Fast formats (these avoid re-encoding when possible)
const FAST_FORMATS = ["aac", "m4a", "mp3", "ogg"];

function getCodec(format) {
  switch (format) {
    case "mp3": return "libmp3lame";
    case "aac": return "aac";
    case "wav": return "pcm_s16le";
    case "ogg": return "libvorbis";
    default: return null;
  }
}

app.post("/extract-audio", upload.single("video"), (req, res) => {
  const { format = "mp3", bitrate = "128k" } = req.body;

  if (!req.file) return res.status(400).json({ error: "No video uploaded" });
  if (!FAST_FORMATS.includes(format))
    return res.status(400).json({ error: "Format not supported for fast conversion" });

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}.${format}`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const codec = getCodec(format);

  res.setHeader("Content-Type", "application/octet-stream");

  const cmd = ffmpeg(inputPath)
    .noVideo()

    // ⚡ Attempt SUPER FAST audio copy first
    .audioCodec("copy")

    // If audio cannot be copied (wrong codec), FFmpeg will fallback
    .on("error", () => {
      // Re-encode fallback using fastest settings
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec(codec)
        .audioBitrate(bitrate)
        .outputOptions("-threads 0")
        .outputOptions("-preset ultrafast")
        .on("end", () => {
          res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
          });
        })
        .on("error", (err) => {
          console.error(err);
          fs.unlinkSync(inputPath);
          res.status(500).json({ error: "Conversion failed" });
        })
        .save(outputPath);
    })

    // FASTEST PATH
    .on("end", () => {
      res.download(outputPath, () => {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      });
    })

    // Max performance options
    .outputOptions("-threads 0")
    .outputOptions("-preset ultrafast")
    .save(outputPath);
});

app.listen(3001, () => console.log("Server running on port 3001"));
