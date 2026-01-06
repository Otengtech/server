import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpeg from "fluent-ffmpeg";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// CORS
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://audioremoveio.vercel.app"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    service: "audio-extractor"
  });
});

// Use /tmp directory for Render compatibility
const UPLOAD_DIR = "/tmp/uploads";
const OUTPUT_DIR = "/tmp/converted";

// Ensure directories exist
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Clean up old files on startup
try {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < oneHourAgo) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          // Ignore errors
        }
      });
    }
  });
} catch (err) {
  console.log("Cleanup error (ignored):", err.message);
}

// Multer setup with temp directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for Render
    files: 1
  }
});

// POST route - Optimized for speed and Render
app.post("/extract-audio", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  
  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded" });
  }

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}`;
  let outputExt = "mp3"; // Default to MP3 for compatibility
  let audioCodec = "copy"; // Try to copy codec first

  try {
    // FAST: Probe video for audio stream (with timeout)
    const probeData = await Promise.race([
      new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, data) => {
          if (err) {
            // Continue even if probe fails
            resolve({ streams: [] });
          } else {
            resolve(data);
          }
        });
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("FFprobe timeout")), 5000)
      )
    ]);

    const audioStream = probeData.streams?.find(s => s.codec_type === "audio");
    
    if (!audioStream) {
      console.log("No audio stream found via probe, using default MP3");
      // Continue anyway, will try to extract
    } else {
      // Determine output extension based on codec
      const codec = audioStream.codec_name;
      
      if (codec === "aac" || codec === "mp4a") {
        outputExt = "m4a";
        audioCodec = "copy";
      } else if (codec === "mp3") {
        outputExt = "mp3";
        audioCodec = "copy";
      } else if (codec === "opus") {
        outputExt = "opus";
        audioCodec = "copy";
      } else if (codec === "vorbis") {
        outputExt = "ogg";
        audioCodec = "copy";
      } else {
        // For unknown codecs, convert to MP3
        outputExt = "mp3";
        audioCodec = "libmp3lame";
      }
    }

    const outputPath = path.join(OUTPUT_DIR, `${outputName}.${outputExt}`);

    // Create ffmpeg command with optimized settings
    const command = ffmpeg(inputPath)
      .noVideo()
      .audioCodec(audioCodec)
      .on("start", (cmdLine) => {
        console.log(`FFmpeg started (${Date.now() - startTime}ms)`);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
        }
      })
      .on("stderr", (stderrLine) => {
        // Log warnings/errors only
        if (stderrLine.toLowerCase().includes("error") || 
            stderrLine.toLowerCase().includes("warning")) {
        }
      })
      .on("error", (err) => {
        
        // If copy failed, try converting to MP3
        if (audioCodec === "copy" && err.message.includes("copy")) {
          console.log("Copy failed, trying MP3 conversion...");
          retryWithMP3Conversion(inputPath, outputName, res, startTime);
          return;
        }
        
        // Cleanup and send error
        cleanupFiles([inputPath, outputPath]);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: "Audio extraction failed", 
            message: err.message 
          });
        }
      })
      .on("end", () => {
        
        // Check if output file exists and has content
        if (!fs.existsSync(outputPath)) {
          cleanupFiles([inputPath]);
          if (!res.headersSent) {
            res.status(500).json({ error: "Output file not created" });
          }
          return;
        }

        const stats = fs.statSync(outputPath);
        if (stats.size === 0) {
          cleanupFiles([inputPath, outputPath]);
          retryWithMP3Conversion(inputPath, outputName, res, startTime);
          return;
        }
        
        // Send the file
        res.download(outputPath, `audio.${outputExt}`, (err) => {
          // Cleanup after download
          cleanupFiles([inputPath, outputPath]);
          
          if (err && !res.headersSent) {
            res.status(500).json({ error: "Download failed" });
          } else {
            console.log(`✓ Total time: ${Date.now() - startTime}ms`);
          }
        });
      });

    // Save to output path
    command.save(outputPath);

  } catch (err) {
    cleanupFiles([inputPath]);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Server error", 
        message: err.message 
      });
    }
  }
});

// Helper function to retry with MP3 conversion
function retryWithMP3Conversion(inputPath, outputName, res, startTime) {
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp3`);
  
  
  ffmpeg(inputPath)
    .noVideo()
    .audioCodec("libmp3lame")
    .audioBitrate("192k")
    .audioChannels(2)
    .audioFrequency(44100)
    .outputOptions("-preset fast")
    .on("start", () => {
    })
    .on("error", (err) => {
      cleanupFiles([inputPath, outputPath]);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Audio conversion failed", 
          message: err.message 
        });
      }
    })
    .on("end", () => {
      
      if (!fs.existsSync(outputPath)) {
        cleanupFiles([inputPath]);
        if (!res.headersSent) {
          res.status(500).json({ error: "MP3 output not created" });
        }
        return;
      }
      
      res.download(outputPath, "audio.mp3", (err) => {
        cleanupFiles([inputPath, outputPath]);
        if (err && !res.headersSent) {
          console.error("Download error:", err);
          res.status(500).json({ error: "Download failed" });
        } else {
          console.log(`✓ Total time with retry: ${Date.now() - startTime}ms`);
        }
      });
    })
    .save(outputPath);
}

// Helper function to cleanup files
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});