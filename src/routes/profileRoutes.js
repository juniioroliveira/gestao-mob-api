const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, profileController.getProfile);
router.put('/', authenticateToken, profileController.updateProfile);
router.put('/preferences', authenticateToken, profileController.updatePreferences);
router.put('/family', authenticateToken, profileController.updateFamily);

module.exports = router;
