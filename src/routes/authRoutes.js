const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// Rota de Login
router.post('/login', authController.login);

// Rota de Registro
router.post('/register', authController.register);

// Rota para gerar token de atalho do iOS (Requer autenticação)
router.get('/shortcut-token', authMiddleware, authController.generateShortcutToken);

router.get('/debug-db', authController.debugDb);

module.exports = router;
