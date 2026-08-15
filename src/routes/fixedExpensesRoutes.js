const express = require('express');
const router = express.Router();
const fixedExpensesController = require('../controllers/fixedExpensesController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, fixedExpensesController.getFixedExpenses);
router.get('/unlinked-transactions', authenticateToken, fixedExpensesController.getUnlinkedTransactions);
router.get('/:id/installments', authenticateToken, fixedExpensesController.getInstallmentsForBill);
router.post('/link', authenticateToken, fixedExpensesController.linkTransaction);
router.post('/', authenticateToken, fixedExpensesController.createFixedExpense);
router.put('/:id', authenticateToken, fixedExpensesController.updateFixedExpense);
router.delete('/:id', authenticateToken, fixedExpensesController.deleteFixedExpense);
router.post('/:id/mark-paid', authenticateToken, fixedExpensesController.markAsPaid);
router.delete('/:id/mark-paid', authenticateToken, fixedExpensesController.unmarkAsPaid);
// Modelo novo de parcelas (Conta Variável com lista de parcelas explícitas)
router.post('/installments/:installmentId/mark-paid', authenticateToken, fixedExpensesController.markInstallmentAsPaid);
router.delete('/installments/:installmentId/mark-paid', authenticateToken, fixedExpensesController.unmarkInstallmentAsPaid);

module.exports = router;
