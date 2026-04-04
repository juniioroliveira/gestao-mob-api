const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'chave_super_secreta_gestao_mob';

exports.login = (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const query = `SELECT * FROM members WHERE email = ?`;
    
    db.get(query, [email], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Erro interno no servidor.' });
        }

        if (!user) {
            return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
        }

        // Comparando a senha informada com o hash no banco
        const isMatch = bcrypt.compareSync(password, user.password_hash);
        
        if (!isMatch) {
            return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
        }

        // Removendo o hash da senha para não enviar na resposta
        delete user.password_hash;

        // Criando o Payload do Token
        const payload = {
            id: user.id,
            family_id: user.family_id,
            role: user.role,
            is_admin: user.is_admin
        };

        // Gerando o JWT
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }); // Expira em 7 dias

        res.status(200).json({
            message: 'Login realizado com sucesso!',
            token: token,
            user: user
        });
    });
};
