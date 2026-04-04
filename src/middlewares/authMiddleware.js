const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'chave_super_secreta_gestao_mob';

const authenticate = (req, res, next) => {
    // Busca o header 'Authorization: Bearer <TOKEN>'
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Tenta decodificar o token
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verifica se o usuário ainda existe no banco de dados
        db.get('SELECT id FROM members WHERE id = ?', [decoded.id], (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Erro ao verificar sessão.' });
            }
            if (!row) {
                return res.status(401).json({ error: 'Sessão inválida. O usuário não existe mais.' });
            }
            
            // Pendura os dados do usuário na requisição
            req.user = decoded;
            
            // Continua pro próximo passo (A Rota protegida)
            next();
        });
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }
};

module.exports = authenticate;
