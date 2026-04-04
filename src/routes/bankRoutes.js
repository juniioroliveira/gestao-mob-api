const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM banks ORDER BY name ASC`, [], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar bancos:', err);
            return res.status(500).json({ error: 'Erro interno' });
        }
        res.json(rows);
    });
});

module.exports = router;