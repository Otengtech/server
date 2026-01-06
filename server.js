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
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// FIX: Set execute permissions for FFprobe on Render
try {
  const ffprobePath = ffprobeInstaller.path;
  if (fs.existsSync(ffprobePath)) {
    // Make ffprobe executable
    fs.chmodSync(ffprobePath, 0o755);
    console.log(`✅ FFprobe permissions set: ${ffprobePath}`);
  } else {
    console.log(`⚠️ FFprobe not found at: ${ffprobePath}`);
  }
} catch (err) {
  console.log(`⚠️ Could not set FFprobe permissions: ${err.message}`);
}

// FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

console.log("FFmpeg path:", ffmpegInstaller.path);
console.log("FFprobe path:", ffprobeInstaller.path);

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

// Test endpoint to check FFmpeg/FFprobe
app.get("/test-ffmpeg", (req, res) => {
  try {
    // Test FFmpeg
    const ffmpegPath = ffmpegInstaller.path;
    const ffprobePath = ffprobeInstaller.path;
    
    const ffmpegExists = fs.existsSync(ffmpegPath);
    const ffprobeExists = fs.existsSync(ffprobePath);
    
    let ffmpegVersion = "Unknown";
    let ffprobeVersion = "Unknown";
    
    if (ffmpegExists) {
      try {
        const ffmpegStats = fs.statSync(ffmpegPath);
        ffmpegVersion = `Exists (Permissions: ${(ffmpegStats.mode & 0o777).toString(8)})`;
      } catch (e) {
        ffmpegVersion = `Exists but error: ${e.message}`;
      }
    }
    
    if (ffprobeExists) {
      try {
        const ffprobeStats = fs.statSync(ffprobePath);
        ffprobeVersion = `Exists (Permissions: ${(ffprobeStats.mode & 0o777).toString(8)})`;
      } catch (e) {
        ffprobeVersion = `Exists but error: ${e.message}`;
      }
    }
    
    res.json({
      ffmpeg: {
        path: ffmpegPath,
        exists: ffmpegExists,
        version: ffmpegVersion
      },
      ffprobe: {
        path: ffprobePath,
        exists: ffprobeExists,
        version: ffprobeVersion
      },
      platform: process.platform,
      arch: process.arch,
      node: process.version
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`;
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

// SIMPLIFIED POST route - No FFprobe dependency
app.post("/extract-audio", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  
  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded" });
  }

  console.log(`Processing: ${req.file.originalname} (${Math.round(req.file.size / 1024 / 1024)} MB)`);

  const inputPath = req.file.path;
  const outputName = `audio-${Date.now()}`;
  
  // Always use MP3 - simpler and more reliable
  const outputExt = "mp3";
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.${outputExt}`);

  try {
    // Simple FFmpeg command without FFprobe
    const command = ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .audioChannels(2)
      .audioFrequency(44100)
      .format('mp3')
      .outputOptions('-preset fast') // Balance between speed and quality
      .on("start", (cmdLine) => {
        console.log(`FFmpeg started (${Date.now() - startTime}ms)`);
        console.log(`Command: ${cmdLine.substring(0, 200)}...`);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
          console.log(`Progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on("stderr", (stderrLine) => {
        // Log important messages
        if (stderrLine.includes('frame=') || stderrLine.includes('time=')) {
          // Progress info - log occasionally
          if (Math.random() < 0.1) { // Log 10% of progress messages
            console.log(`FFmpeg: ${stderrLine.trim()}`);
          }
        } else if (stderrLine.toLowerCase().includes("error")) {
          console.error(`FFmpeg ERROR: ${stderrLine}`);
        }
      })
      .on("error", (err, stdout, stderr) => {
        console.error('FFmpeg process error:', err.message);
        console.error('FFmpeg stderr:', stderr);
        
        // Cleanup and send error
        cleanupFiles([inputPath, outputPath]);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: "Audio extraction failed", 
            message: err.message,
            details: stderr.substring(0, 200) // First 200 chars
          });
        }
      })
      .on("end", () => {
        console.log(`Processing complete (${Date.now() - startTime}ms)`);
        
        // Check if output file exists and has content
        if (!fs.existsSync(outputPath)) {
          cleanupFiles([inputPath]);
          if (!res.headersSent) {
            res.status(500).json({ error: "Output file not created" });
          }
          return;
        }

        const stats = fs.statSync(outputPath);
        console.log(`Output file size: ${stats.size} bytes`);
        
        if (stats.size === 0) {
          cleanupFiles([inputPath, outputPath]);
          if (!res.headersSent) {
            res.status(500).json({ error: "Empty output file created" });
          }
          return;
        }

        // Send the file
        res.download(outputPath, `audio.${outputExt}`, (err) => {
          // Cleanup after download
          cleanupFiles([inputPath, outputPath]);
          
          if (err && !res.headersSent) {
            console.error("Download error:", err);
            res.status(500).json({ error: "Download failed", message: err.message });
          } else {
            console.log(`✓ Success! Total time: ${Date.now() - startTime}ms`);
          }
        });
      });

    // Save to output path
    command.save(outputPath);

  } catch (err) {
    console.error("Server ERROR:", err.message, err.stack);
    cleanupFiles([inputPath]);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Server error", 
        message: err.message 
      });
    }
  }
});

// Helper function to cleanup files
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${filePath}`);
      } catch (err) {
        console.log(`Failed to cleanup ${filePath}: ${err.message}`);
      }
    }
  });
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});