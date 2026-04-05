const express = require('express');
const router = express.Router();
const testHeaderController = require('../controllers/testHeaderController');

router.post('/', testHeaderController.testHeaders);
module.exports = router;
