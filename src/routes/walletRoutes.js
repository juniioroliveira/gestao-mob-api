const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, walletController.getWalletData);
router.get('/thermometer-ai', authenticateToken, walletController.getThermometerAIData);
router.post('/thermometer-action', authenticateToken, walletController.executeAIAction);

module.exports = router;
