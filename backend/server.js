const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'drone-catalog.appspot.com' // Replace with your project's bucket (from Firebase Console > Storage)
});
const bucket = admin.storage().bucket();

// Middleware
app.use(cors());
app.use(express.json());

// Multer for in-memory storage (before upload to Firebase)
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

// In-memory metadata (use Firestore for production persistence)
let mediaFiles = [];

// Calculate total size from Firebase (async)
async function getTotalSize() {
  let total = 0;
  try {
    const [files] = await bucket.getFiles({ prefix: 'media/' });
    for (const file of files) {
      const [metadata] = await file.getMetadata();
      total += parseInt(metadata.size, 10);
    }
  } catch (err) {
    console.error('Error calculating total size:', err);
  }
  return total;
}

// Routes
app.get('/api/media', async (req, res) => {
  // Fetch metadata from Firebase Storage
  try {
    const [files] = await bucket.getFiles({ prefix: 'media/' });
    mediaFiles = [];
    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const fileName = metadata.name.split('/').pop();
      mediaFiles.push({
        id: uuidv4(), // Generate client-side compatible ID
        name: fileName,
        type: metadata.contentType,
        url: `https://storage.googleapis.com/${bucket.name}/${metadata.name}?alt=media`, // Public URL
        platformId: null, // Default; update via PUT
        isThumbnail: false // Default; update via PUT
      });
    }
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

  // Check total size
  const currentSize = await getTotalSize();
  const newSize = currentSize + req.file.size;
  if (newSize > MAX_TOTAL_SIZE) {
    return res.status(413).json({ error: 'Total storage capacity exceeded (500MB limit)' });
  }

  try {
    const fileName = `media/${uuidv4()}${path.extname(req.file.originalname)}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });
    await file.makePublic(); // Make accessible via URL

    const [metadata] = await file.getMetadata();
    const newFile = {
      id: uuidv4(),
      name: req.body.name || req.file.originalname,
      type: req.file.mimetype,
      url: metadata.mediaLink, // Public URL from Firebase
      platformId: req.body.platformId || null,
      isThumbnail: req.body.isThumbnail === 'true'
    };
    mediaFiles.push(newFile); // Cache locally
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
  const fileIndex = mediaFiles.findIndex(f => f.id === id);
  if (fileIndex === -1) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    // Extract Firebase path from URL (e.g., /media/uuid.ext)
    const firebasePath = mediaFiles[fileIndex].url.split(bucket.name + '/')[1].split('?')[0];
    await bucket.file(firebasePath).delete();
    mediaFiles.splice(fileIndex, 1);
    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error('Error deleting from Firebase:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
