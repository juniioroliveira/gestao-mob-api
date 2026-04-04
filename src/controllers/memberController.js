const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { getIo } = require('../websockets/socket');

exports.inviteMember = async (req, res) => {
    const { email, name, role, isAdmin } = req.body;
    const familyId = req.user.family_id;

    if (!email || !role) {
        return res.status(400).json({ error: 'E-mail e Papel são obrigatórios' });
    }

    try {
        // Verificar se o email já existe
        const existingMember = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM members WHERE email = ?`, [email], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingMember) {
            return res.status(400).json({ error: 'E-mail já está cadastrado' });
        }

        // Para teste, definimos uma senha padrão
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash('123456', salt);

        const isAdminValue = isAdmin ? 1 : 0;

        const insertQuery = `
            INSERT INTO members (family_id, name, email, password_hash, role, is_admin)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        db.run(insertQuery, [familyId, name || email.split('@')[0], email, passwordHash, role, isAdminValue], function(err) {
            if (err) {
                console.error('Erro ao inserir membro:', err);
                return res.status(500).json({ error: 'Erro ao criar membro' });
            }
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'members', action: 'created' });
            res.status(201).json({ message: 'Convite enviado (membro criado com senha padrão 123456)' });
        });

    } catch (err) {
        console.error('Erro no convite de membro:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

exports.deleteMember = (req, res) => {
    const memberId = req.params.id;
    const familyId = req.user.family_id;

    // Verificar se o usuário atual é admin ou não (lógica de segurança)
    const checkQuery = `SELECT is_admin FROM members WHERE id = ?`;
    
    db.get(checkQuery, [req.user.id], (err, row) => {
        if (err || !row) return res.status(500).json({ error: 'Erro interno' });
        if (!row.is_admin) return res.status(403).json({ error: 'Apenas administradores podem remover membros' });

        // Excluir o membro, desde que seja da mesma família
        const deleteQuery = `DELETE FROM members WHERE id = ? AND family_id = ?`;
        db.run(deleteQuery, [memberId, familyId], function(err) {
            if (err) {
                console.error('Erro ao excluir membro:', err);
                return res.status(500).json({ error: 'Erro ao remover membro' });
            }
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'members', action: 'deleted' });
            res.json({ message: 'Membro removido com sucesso' });
        });
    });
};

exports.updateMember = (req, res) => {
    const memberId = req.params.id;
    const familyId = req.user.family_id;
    const { name, role, isAdmin } = req.body;

    if (!name || !role) {
        return res.status(400).json({ error: 'Nome e papel são obrigatórios' });
    }

    const checkQuery = `SELECT is_admin FROM members WHERE id = ?`;
    
    db.get(checkQuery, [req.user.id], (err, row) => {
        if (err || !row) return res.status(500).json({ error: 'Erro interno' });
        if (!row.is_admin) return res.status(403).json({ error: 'Apenas administradores podem editar membros' });

        const isAdminValue = isAdmin ? 1 : 0;

        const updateQuery = `UPDATE members SET name = ?, role = ?, is_admin = ? WHERE id = ? AND family_id = ?`;
        db.run(updateQuery, [name, role, isAdminValue, memberId, familyId], function(err) {
            if (err) {
                console.error('Erro ao editar membro:', err);
                return res.status(500).json({ error: 'Erro ao atualizar membro' });
            }
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'members', action: 'updated' });
            res.json({ message: 'Membro atualizado com sucesso' });
        });
    });
};