const jwt = require('jsonwebtoken');

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
        
        // Pendura os dados do usuário na requisição
        req.user = decoded;
        
        // Continua pro próximo passo (A Rota protegida)
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }
};

module.exports = authenticate;
