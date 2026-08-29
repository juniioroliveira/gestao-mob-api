const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/statisticsController');
const authenticateToken = require('../middlewares/authMiddleware');
const requireAdmin = require('../middlewares/requireAdmin');

router.get('/', authenticateToken, statisticsController.getStatisticsData);
router.get('/monthly-overview', authenticateToken, statisticsController.getMonthlyOverview);
router.get('/monthly-overview/detail', authenticateToken, statisticsController.getMonthlyOverviewDetail);
router.get('/categories/:id/suggested-percent', authenticateToken, statisticsController.getSuggestedCategoryPercent);
// Gerenciar categorias/limites é restrito a administradores da família.
router.post('/categories', authenticateToken, requireAdmin, statisticsController.createCategory);
router.put('/categories/:id', authenticateToken, requireAdmin, statisticsController.updateCategory);
router.delete('/categories/:id', authenticateToken, requireAdmin, statisticsController.deleteCategory);

module.exports = router;
