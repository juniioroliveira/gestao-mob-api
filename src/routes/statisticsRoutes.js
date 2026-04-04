const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/statisticsController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, statisticsController.getStatisticsData);
router.post('/categories', authenticateToken, statisticsController.createCategory);
router.put('/categories/:id', authenticateToken, statisticsController.updateCategory);

module.exports = router;
