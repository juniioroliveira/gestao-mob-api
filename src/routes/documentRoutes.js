const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const documentController = require('../controllers/documentController');
const authenticateToken = require('../middlewares/authMiddleware');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Routes
router.post('/upload', authenticateToken, upload.single('document'), documentController.uploadDocument);
router.get('/inbox', authenticateToken, documentController.getInboxDocuments);
router.get('/:id/file', authenticateToken, documentController.getDocumentFile);
router.get('/inbox/unread-count', authenticateToken, documentController.getUnreadCount);
router.post('/inbox/mark-read', authenticateToken, documentController.markInboxRead);
router.post('/:id/mark-read', authenticateToken, documentController.markDocumentRead);
router.delete('/:id', authenticateToken, documentController.deleteDocument);
router.post('/inbox/:id/cancel', authenticateToken, documentController.cancelDocument);
router.post('/inbox/:id/reprocess', authenticateToken, documentController.reprocessDocument);
router.post('/inbox/:id/confirm-suggestion', authenticateToken, documentController.confirmSuggestion);
router.post('/inbox/:id/dismiss-suggestion', authenticateToken, documentController.dismissSuggestion);

module.exports = router;
