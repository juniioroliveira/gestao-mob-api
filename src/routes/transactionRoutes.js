const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, transactionController.getAccountTransactions);
router.post('/', authenticateToken, transactionController.createTransaction);
router.post('/import-ofx', authenticateToken, transactionController.importOFX);
router.get('/import-job/:jobId', authenticateToken, transactionController.getImportJobStatus);
router.get('/health-ai', transactionController.healthAI);
router.delete('/clear', authenticateToken, transactionController.clearTransactions);
router.put('/:id', authenticateToken, transactionController.updateTransaction);
router.delete('/:id', authenticateToken, transactionController.deleteTransaction);

module.exports = router;
