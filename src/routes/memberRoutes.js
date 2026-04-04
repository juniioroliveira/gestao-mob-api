const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const authenticateToken = require('../middlewares/authMiddleware');

router.post('/invite', authenticateToken, memberController.inviteMember);
router.put('/:id', authenticateToken, memberController.updateMember);
router.delete('/:id', authenticateToken, memberController.deleteMember);

module.exports = router;
