const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_PATH = '/mnt/disk/uploads';
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_PATH));

// Ensure upload directory exists
fs.ensureDirSync(UPLOAD_PATH);

// In-memory metadata (for simplicity; use a DB like PostgreSQL for production)
let mediaFiles = [];

// Function to get total directory size
async function getDirSize(dir) {
  let total = 0;
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    if (file.isDirectory()) {
      total += await getDirSize(filePath);
    } else {
      total += (await fs.stat(filePath)).size;
    }
  }
  return total;
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_PATH);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Use JPEG, PNG, MP4, WebM, MP3, or WAV.'));
    }
  }
});

// Routes
app.get('/api/media', (req, res) => {
  res.json(mediaFiles);
});

app.post('/api/media', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Check total size
  const currentSize = await getDirSize(UPLOAD_PATH);
  const newSize = currentSize + req.file.size;
  if (newSize > MAX_TOTAL_SIZE) {
    await fs.unlink(path.join(UPLOAD_PATH, req.file.filename));
    return res.status(413).json({ error: 'Total storage capacity exceeded (500MB limit)' });
  }

  const newFile = {
    id: uuidv4(),
    name: req.body.name || req.file.originalname,
    type: req.file.mimetype,
    url: `/uploads/${req.file.filename}`,
    platformId: req.body.platformId || null,
    isThumbnail: req.body.isThumbnail === 'true'
  };
  mediaFiles.push(newFile);
  res.json(newFile);
});

app.put('/api/media/:id', async (req, res) => {
  const { id } = req.params;
  const { name, platformId, isThumbnail } = req.body;
  const file = mediaFiles.find(f => f.id === id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (name) file.name = name;
  if (platformId !== undefined) file.platformId = platformId;
  if (isThumbnail !== undefined) {
    if (isThumbnail && platformId) {
      // Clear other thumbnails for this platform
      mediaFiles.forEach(f => {
        if (f.platformId === platformId && f.id !== id) {
          f.isThumbnail = false;
        }
      });
      file.isThumbnail = true;
    } else {
      file.isThumbnail = false;
    }
  }
  res.json(file);
});

app.delete('/api/media/:id', async (req, res) => {
  const { id } = req.params;
  const file = mediaFiles.find(f => f.id === id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    await fs.unlink(path.join(UPLOAD_PATH, path.basename(file.url)));
    mediaFiles = mediaFiles.filter(f => f.id !== id);
    res.json({ message: 'File deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
