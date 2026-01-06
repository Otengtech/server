import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import axios from "axios";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// AssemblyAI Configuration
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "your_assemblyai_api_key_here"; // Get from: https://www.assemblyai.com/dashboard/
const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";

// CORS
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://server-uhlg.onrender.com",
    "https://audioremoveio.vercel.app"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    service: "audio-extractor",
    provider: "AssemblyAI"
  });
});

// Check AssemblyAI status
app.get("/api-status", async (req, res) => {
  try {
    const response = await axios.get(`${ASSEMBLYAI_BASE_URL}/account`, {
      headers: {
        'Authorization': ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    res.json({
      status: "active",
      provider: "AssemblyAI",
      account: response.data,
      limits: {
        free_hours_per_month: 5,
        used_this_month: response.data.plan?.hours_used || 0,
        remaining: (5 - (response.data.plan?.hours_used || 0)).toFixed(2)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
      provider: "AssemblyAI"
    });
  }
});

// Use /tmp directory for Render compatibility
const UPLOAD_DIR = "/tmp/uploads";

// Ensure directories exist
[UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Clean up old files on startup
try {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  if (fs.existsSync(UPLOAD_DIR)) {
    const files = fs.readdirSync(UPLOAD_DIR);
    files.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, file);
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
    fileSize: 100 * 1024 * 1024, // 100MB limit (AssemblyAI supports up to 5GB)
    files: 1
  }
});

// Method 1: Direct AssemblyAI Upload & Extraction
app.post("/extract-audio", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  
  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded" });
  }

  console.log(`Processing: ${req.file.originalname} (${Math.round(req.file.size / 1024 / 1024)} MB)`);

  try {
    // Step 1: Upload video to AssemblyAI
    console.log("Uploading to AssemblyAI...");
    
    const uploadResponse = await axios.post(
      `${ASSEMBLYAI_BASE_URL}/upload`,
      fs.createReadStream(req.file.path),
      {
        headers: {
          'Authorization': ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    const audioUrl = uploadResponse.data.upload_url;
    console.log("Upload successful, audio URL:", audioUrl);

    // Step 2: Get direct audio URL (AssemblyAI returns direct link)
    // Since AssemblyAI already processes and returns audio, we can directly serve it
    
    // Step 3: Fetch the audio file
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer'
    });

    // Step 4: Send audio to client
    const audioBuffer = Buffer.from(audioResponse.data);
    
    // Determine content type
    let contentType = 'audio/mpeg';
    if (req.file.originalname.toLowerCase().endsWith('.mp4') || 
        req.file.originalname.toLowerCase().endsWith('.m4a')) {
      contentType = 'audio/mp4';
    } else if (req.file.originalname.toLowerCase().endsWith('.wav')) {
      contentType = 'audio/wav';
    } else if (req.file.originalname.toLowerCase().endsWith('.ogg')) {
      contentType = 'audio/ogg';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="audio${getExtension(contentType)}"`);
    res.setHeader('Content-Length', audioBuffer.length);
    
    console.log(`✓ Audio extraction completed in ${Date.now() - startTime}ms`);
    
    // Cleanup
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.send(audioBuffer);

  } catch (error) {
    console.error("AssemblyAI error:", error.response?.data || error.message);
    
    // Cleanup
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    // Fallback to FFmpeg if AssemblyAI fails
    if (!res.headersSent) {
      console.log("Falling back to FFmpeg processing...");
      await fallbackToFFmpeg(req.file.path, req.file.originalname, res, startTime);
    }
  }
});

// Method 2: Alternative endpoint with transcription option
app.post("/extract-with-transcript", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  
  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded" });
  }

  try {
    // Step 1: Upload to AssemblyAI
    const uploadResponse = await axios.post(
      `${ASSEMBLYAI_BASE_URL}/upload`,
      fs.createReadStream(req.file.path),
      {
        headers: {
          'Authorization': ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/octet-stream'
        }
      }
    );

    const audioUrl = uploadResponse.data.upload_url;

    // Step 2: Create transcription request
    const transcriptResponse = await axios.post(
      `${ASSEMBLYAI_BASE_URL}/transcript`,
      {
        audio_url: audioUrl,
        format_text: true
      },
      {
        headers: {
          'Authorization': ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const transcriptId = transcriptResponse.data.id;
    
    // Step 3: Poll for transcription completion
    let transcript = null;
    for (let i = 0; i < 30; i++) { // 30 attempts, 10 seconds each = 5 minutes max
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      const statusResponse = await axios.get(
        `${ASSEMBLYAI_BASE_URL}/transcript/${transcriptId}`,
        {
          headers: {
            'Authorization': ASSEMBLYAI_API_KEY
          }
        }
      );
      
      if (statusResponse.data.status === 'completed') {
        transcript = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'error') {
        throw new Error('Transcription failed');
      }
    }

    if (!transcript) {
      throw new Error('Transcription timeout');
    }

    // Step 4: Get the audio
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer'
    });

    const audioBuffer = Buffer.from(audioResponse.data);
    
    // Send both audio and transcript
    res.json({
      success: true,
      processing_time: Date.now() - startTime,
      audio: {
        url: audioUrl,
        size: audioBuffer.length,
        format: 'mp3'
      },
      transcript: {
        text: transcript.text,
        words: transcript.words,
        confidence: transcript.confidence
      },
      download_url: `/download-audio?url=${encodeURIComponent(audioUrl)}`
    });

    // Cleanup
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

  } catch (error) {
    console.error("Error:", error.message);
    
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    if (!res.headersSent) {
      res.status(500).json({
        error: "Processing failed",
        message: error.message
      });
    }
  }
});

// Helper endpoint to download audio from URL
app.get("/download-audio", async (req, res) => {
  try {
    const audioUrl = req.query.url;
    
    if (!audioUrl) {
      return res.status(400).json({ error: "No audio URL provided" });
    }

    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer'
    });

    const audioBuffer = Buffer.from(response.data);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Length', audioBuffer.length);
    
    res.send(audioBuffer);
  } catch (error) {
    res.status(500).json({ error: "Download failed", message: error.message });
  }
});

// Fallback method using FFmpeg (if AssemblyAI fails)
async function fallbackToFFmpeg(filePath, originalName, res, startTime) {
  try {
    // Check if FFmpeg is available
    let ffmpeg;
    try {
      ffmpeg = (await import('fluent-ffmpeg')).default;
      const ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default;
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    } catch (ffmpegError) {
      throw new Error('FFmpeg not available for fallback');
    }

    const outputPath = `/tmp/fallback-${Date.now()}.mp3`;
    
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .format('mp3')
        .outputOptions('-preset fast')
        .on('end', () => {
          const audioBuffer = fs.readFileSync(outputPath);
          
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
          res.setHeader('Content-Length', audioBuffer.length);
          
          res.send(audioBuffer);
          
          // Cleanup
          [filePath, outputPath].forEach(path => {
            if (fs.existsSync(path)) fs.unlinkSync(path);
          });
          
          console.log(`✓ Fallback FFmpeg completed in ${Date.now() - startTime}ms`);
          resolve();
        })
        .on('error', (err) => {
          reject(err);
        })
        .save(outputPath);
    });
  } catch (error) {
    throw error;
  }
}

// Helper function to get file extension from content type
function getExtension(contentType) {
  const extensions = {
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac'
  };
  return extensions[contentType] || '.mp3';
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
});