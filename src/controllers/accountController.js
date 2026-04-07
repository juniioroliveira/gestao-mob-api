const db = require('../config/database');
const { getIo } = require('../websockets/socket');

exports.createAccount = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const { name, type, initialBalance, bankCode, colorHex, lastDigits } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'O nome da conta é obrigatório' });
    }

    const query = `INSERT INTO accounts (family_id, member_id, name, type, current_balance, bank_code, color_hex, card_last_digits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [familyId, memberId, name, type || 'PERSONAL', initialBalance || 0, bankCode || null, colorHex || null, lastDigits || null], function(err) {
        if (err) {
            console.error('Erro ao criar conta:', err);
            return res.status(500).json({ error: 'Erro ao criar conta' });
        }

        getIo().to(`family_${familyId}`).emit('data_updated', {
            source: 'accounts',
            action: 'created'
        });

        res.status(201).json({ message: 'Conta criada com sucesso', id: this.lastID });
    });
};

exports.updateAccount = (req, res) => {
    const familyId = req.user.family_id;
    const accountId = req.params.id;
    const { name, type, bankCode, colorHex, lastDigits } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'O nome da conta é obrigatório' });
    }

    db.get(`SELECT id FROM accounts WHERE id = ? AND family_id = ?`, [accountId, familyId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Conta não encontrada ou sem permissão' });
        }

        const query = `UPDATE accounts SET name = ?, type = ?, bank_code = ?, color_hex = ?, card_last_digits = ? WHERE id = ?`;
        db.run(query, [name, type || 'PERSONAL', bankCode || null, colorHex || null, lastDigits || null, accountId], function(errUpdate) {
            if (errUpdate) {
                console.error('Erro ao atualizar conta:', errUpdate);
                return res.status(500).json({ error: 'Erro ao atualizar conta' });
            }

            getIo().to(`family_${familyId}`).emit('data_updated', {
                source: 'accounts',
                action: 'updated'
            });

            res.json({ message: 'Conta atualizada com sucesso' });
        });
    });
};

exports.deleteAccount = (req, res) => {
    const familyId = req.user.family_id;
    const accountId = req.params.id;

    // Primeiro verifica se a conta pertence à família
    db.get(`SELECT id FROM accounts WHERE id = ? AND family_id = ?`, [accountId, familyId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Conta não encontrada ou sem permissão' });
        }

        db.run(`DELETE FROM accounts WHERE id = ?`, [accountId], (errDelete) => {
            if (errDelete) {
                console.error('Erro ao excluir conta:', errDelete);
                return res.status(500).json({ error: 'Erro ao excluir conta' });
            }

            getIo().to(`family_${familyId}`).emit('data_updated', {
                source: 'accounts',
                action: 'deleted'
            });

            res.json({ message: 'Conta excluída com sucesso' });
        });
    });
};
