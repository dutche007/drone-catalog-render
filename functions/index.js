const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
const storage = new Storage();
const bucket = storage.bucket('drone-catalog-6d8a8.appspot.com');

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// Multer for in-memory uploads
const upload = multer({
  storage: multer.memoryStorage(),
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

// In-memory cache for metadata
let mediaFiles = [];

// Routes
app.get('/api/media', async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: 'media/' });
    mediaFiles = files.map(file => ({
      id: uuidv4(),
      name: path.basename(file.name),
      type: file.metadata.contentType,
      url: `https://storage.googleapis.com/${bucket.name}/${file.name}?alt=media`,
      platformId: null,
      isThumbnail: false
    }));
    res.json(mediaFiles);
  } catch (err) {
    console.error('Error fetching media:', err);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

app.post('/api/media', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const fileName = `media/${uuidv4()}${path.extname(req.file.originalname)}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype },
      public: true
    });

    const [metadata] = await file.getMetadata();
    const newFile = {
      id: uuidv4(),
      name: req.body.name || req.file.originalname,
      type: req.file.mimetype,
      url: metadata.mediaLink,
      platformId: req.body.platformId || null,
      isThumbnail: req.body.isThumbnail === 'true'
    };
    mediaFiles.push(newFile);
    res.json(newFile);
  } catch (err) {
    console.error('Error uploading to Firebase:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
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
    const firebasePath = file.url.split(`${bucket.name}/`)[1]?.split('?')[0];
    if (firebasePath) {
      await bucket.file(firebasePath).delete();
    }
    mediaFiles = mediaFiles.filter(f => f.id !== id);
    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error('Error deleting from Firebase:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Export as Cloud Function
exports.api = functions.https.onRequest(app);
