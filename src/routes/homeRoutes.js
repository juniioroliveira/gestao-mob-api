const express = require('express');
const router = express.Router();
const homeController = require('../controllers/homeController');
const authenticate = require('../middlewares/authMiddleware');

// Protege todas as rotas de Home
router.use(authenticate);

// Rota principal para carregar o Dashboard
router.get('/', homeController.getHomeData);

module.exports = router;