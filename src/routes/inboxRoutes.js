const express = require('express');
const router = express.Router();
const multer = require('multer');
const inboxController = require('../controllers/inboxController');
const authenticateToken = require('../middlewares/authMiddleware');

// Configuração do multer em memória
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // Limite de 10MB
    }
});

// A rota recebe um campo chamado "file" (conforme configurado no Atalho do iOS)
router.post('/upload', authenticateToken, upload.single('file'), inboxController.processUpload);

module.exports = router;
