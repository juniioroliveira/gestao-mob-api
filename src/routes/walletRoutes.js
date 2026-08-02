const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, walletController.getWalletData);
router.get('/thermometer-ai', authenticateToken, walletController.getThermometerAIData);

module.exports = router;
