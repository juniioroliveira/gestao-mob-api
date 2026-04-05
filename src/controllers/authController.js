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

exports.forceSeed = (req, res) => {
    const fs = require('fs');
    const path = require('path');
    try {
        const seedPath = path.resolve(__dirname, '../../database_seed.sqlite');
        const dbPath = path.resolve(__dirname, '../../database.sqlite');
        
        if (fs.existsSync(seedPath)) {
            fs.copyFileSync(seedPath, dbPath);
            res.json({ message: "Banco restaurado com sucesso a partir do database_seed.sqlite!" });
        } else {
            res.status(404).json({ error: "Arquivo de seed não encontrado." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.forceSeed = (req, res) => {
    const fs = require('fs');
    const path = require('path');
    try {
        const seedPath = path.resolve(__dirname, '../../database_seed.sqlite');
        const dbPath = path.resolve(__dirname, '../../database.sqlite');
        
        if (fs.existsSync(seedPath)) {
            fs.copyFileSync(seedPath, dbPath);
            res.json({ message: "Banco restaurado com sucesso a partir do database_seed.sqlite!" });
        } else {
            res.status(404).json({ error: "Arquivo de seed não encontrado." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.debugDb = (req, res) => {
    const fs = require('fs');
    const path = require('path');
    res.json({
        cwd: process.cwd(),
        dirname: __dirname,
        env: process.env.NODE_ENV,
        home: require('os').homedir()
    });
};

exports.register = (req, res) => {
    const { name, email, password, familyName } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }

    const finalFamilyName = familyName || `Família de ${name.split(' ')[0]}`;

    // Verifica se o email já existe
    db.get(`SELECT id FROM members WHERE email = ?`, [email], (err, existingUser) => {
        if (err) return res.status(500).json({ error: 'Erro ao verificar email.' });
        if (existingUser) return res.status(400).json({ error: 'Este e-mail já está em uso.' });

        // Cria a família
        db.run(`INSERT INTO families (name) VALUES (?)`, [finalFamilyName], function (err) {
            if (err) return res.status(500).json({ error: 'Erro ao criar família.' });
            
            const familyId = this.lastID;
            const hashedPassword = bcrypt.hashSync(password, 10);

            // Cria o usuário como admin da família
            db.run(`
                INSERT INTO members (family_id, name, email, password_hash, role, is_admin)
                VALUES (?, ?, ?, ?, 'ADMIN', 1)
            `, [familyId, name, email, hashedPassword], function (err) {
                if (err) return res.status(500).json({ error: 'Erro ao criar usuário.' });

                const userId = this.lastID;
                
                // Cria uma conta inicial para não ficar vazio
                db.run(`
                    INSERT INTO accounts (family_id, member_id, name, type, bank_code, current_balance, credit_limit, is_credit_card, closing_day, due_day)
                    VALUES (?, ?, ?, 'PERSONAL', '000', 0, 0, 0, null, null)
                `, [familyId, userId, 'Conta Principal']);

                // Criar algumas categorias padrão
                const defaultCategories = [
                    ['Supermercado', 'shopping_cart', '#FF5722'],
                    ['Salário', 'attach_money', '#4CAF50'],
                    ['Lazer', 'sports_esports', '#2196F3'],
                    ['Moradia', 'home', '#9C27B0'],
                    ['Transporte', 'directions_car', '#FF9800']
                ];
                
                const stmt = db.prepare('INSERT INTO categories (family_id, name, icon, color_hex) VALUES (?, ?, ?, ?)');
                defaultCategories.forEach(cat => {
                    stmt.run(familyId, cat[0], cat[1], cat[2]);
                });
                stmt.finalize();

                // Gera token para login automático
                const payload = {
                    id: userId,
                    family_id: familyId,
                    role: 'ADMIN',
                    is_admin: 1
                };
                
                const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

                res.status(201).json({
                    message: 'Conta criada com sucesso!',
                    token: token,
                    user: {
                        id: userId,
                        family_id: familyId,
                        name: name,
                        email: email,
                        role: 'ADMIN',
                        is_admin: 1
                    }
                });
            });
        });
    });
};
