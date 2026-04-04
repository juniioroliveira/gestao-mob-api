const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const authenticateToken = require('../middlewares/authMiddleware');

router.post('/', authenticateToken, accountController.createAccount);
router.delete('/:id', authenticateToken, accountController.deleteAccount);

module.exports = router;