const express = require('express');
const router = express.Router();
const fixedExpensesController = require('../controllers/fixedExpensesController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, fixedExpensesController.getFixedExpenses);

module.exports = router;
