const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authenticateToken = require('../middlewares/authMiddleware');

router.post('/', authenticateToken, transactionController.createTransaction);
router.put('/:id', authenticateToken, transactionController.updateTransaction);
router.delete('/:id', authenticateToken, transactionController.deleteTransaction);

module.exports = router;
