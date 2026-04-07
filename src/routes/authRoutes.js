const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Rota de Login
router.post('/login', authController.login);

// Rota de Registro
router.post('/register', authController.register);

router.get('/debug-db', authController.debugDb);

module.exports = router;
