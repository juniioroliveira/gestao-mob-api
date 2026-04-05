const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Rota de Login
router.post('/login', authController.login);

// Rota de Registro
router.post('/register', authController.register);

// [TEMP] Rota para restaurar o banco de dados oficial via arquivo de seed
router.get('/force-seed', authController.forceSeed);

router.get('/debug-db', authController.debugDb);

module.exports = router;
