const express = require('express');
const router = express.Router();
const fixedExpensesController = require('../controllers/fixedExpensesController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, fixedExpensesController.getFixedExpenses);
router.post('/', authenticateToken, fixedExpensesController.createFixedExpense);
router.put('/:id', authenticateToken, fixedExpensesController.updateFixedExpense);
router.delete('/:id', authenticateToken, fixedExpensesController.deleteFixedExpense);

module.exports = router;
