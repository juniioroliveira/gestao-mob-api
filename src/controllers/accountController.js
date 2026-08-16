const db = require('../config/database');
const { getIo } = require('../websockets/socket');
const { triggerUpdate } = require('../services/financialEventService');

// Resolve o dono da conta a partir do body: quando o cliente manda a chave
// `memberId` explicitamente (mesmo que null, pra "Casa"/compartilhada), respeita
// o que veio; clientes antigos que nunca mandam essa chave continuam caindo no
// comportamento de sempre (dono = quem está criando). `null`/"Casa" só é aceito
// se validado contra a família antes de usar (feito por quem chama).
function resolveMemberIdFromBody(req) {
    if (Object.prototype.hasOwnProperty.call(req.body, 'memberId')) {
        return req.body.memberId === undefined ? null : req.body.memberId;
    }
    return req.user.id;
}

exports.createAccount = (req, res) => {
    const familyId = req.user.family_id;
    const { name, type, initialBalance, bankCode, colorHex, lastDigits, isDebit, isCredit, creditLimit, closingDay, dueDay } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'O nome da conta é obrigatório' });
    }

    const isDebitVal = (isDebit === undefined) ? 1 : (isDebit ? 1 : 0);
    const isCreditVal = (isCredit === undefined) ? 0 : (isCredit ? 1 : 0);
    const creditLimitVal = creditLimit || 0;
    const memberId = resolveMemberIdFromBody(req);

    const insertWithMember = (validatedMemberId) => {
        const query = `INSERT INTO accounts (family_id, member_id, name, type, current_balance, bank_code, color_hex, card_last_digits, is_debit, is_credit, credit_limit, closing_day, due_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(query, [familyId, validatedMemberId, name, type || 'PERSONAL', initialBalance || 0, bankCode || null, colorHex || null, lastDigits || null, isDebitVal, isCreditVal, creditLimitVal, closingDay || null, dueDay || null], function(err) {
            if (err) {
                console.error('Erro ao criar conta:', err);
                return res.status(500).json({ error: 'Erro ao criar conta' });
            }

            getIo().to(`family_${familyId}`).emit('data_updated', {
                source: 'accounts',
                action: 'created'
            });
            triggerUpdate(familyId);
            res.status(201).json({ message: 'Conta criada com sucesso', id: this.lastID });
        });
    };

    if (memberId === null) {
        insertWithMember(null); // "Casa" — compartilhada, sem dono
    } else {
        // Confere que o dono escolhido é mesmo alguém da família antes de gravar —
        // sem isso, um cliente malicioso poderia atribuir a conta a um id de fora.
        db.get(`SELECT id FROM members WHERE id = ? AND family_id = ?`, [memberId, familyId], (err, row) => {
            if (err) return res.status(500).json({ error: 'Erro ao validar responsável pela conta' });
            if (!row) return res.status(400).json({ error: 'Responsável inválido para esta família' });
            insertWithMember(memberId);
        });
    }
};

exports.updateAccount = (req, res) => {
    const familyId = req.user.family_id;
    const accountId = req.params.id;
    const { name, type, bankCode, colorHex, lastDigits, isDebit, isCredit, creditLimit, closingDay, dueDay } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'O nome da conta é obrigatório' });
    }

    const isDebitVal = (isDebit === undefined) ? 1 : (isDebit ? 1 : 0);
    const isCreditVal = (isCredit === undefined) ? 0 : (isCredit ? 1 : 0);
    const creditLimitVal = creditLimit || 0;
    const memberId = resolveMemberIdFromBody(req);

    db.get(`SELECT id FROM accounts WHERE id = ? AND family_id = ?`, [accountId, familyId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Conta não encontrada ou sem permissão' });
        }

        const updateWithMember = (validatedMemberId) => {
            const query = `UPDATE accounts SET name = ?, type = ?, member_id = ?, bank_code = ?, color_hex = ?, card_last_digits = ?, is_debit = ?, is_credit = ?, credit_limit = ?, closing_day = ?, due_day = ? WHERE id = ?`;
            db.run(query, [name, type || 'PERSONAL', validatedMemberId, bankCode || null, colorHex || null, lastDigits || null, isDebitVal, isCreditVal, creditLimitVal, closingDay || null, dueDay || null, accountId], function(errUpdate) {
                if (errUpdate) {
                    console.error('Erro ao atualizar conta:', errUpdate);
                    return res.status(500).json({ error: 'Erro ao atualizar conta' });
                }

                getIo().to(`family_${familyId}`).emit('data_updated', {
                    source: 'accounts',
                    action: 'updated'
                });
                triggerUpdate(familyId);
                res.json({ message: 'Conta atualizada com sucesso' });
            });
        };

        if (memberId === null) {
            updateWithMember(null);
        } else {
            db.get(`SELECT id FROM members WHERE id = ? AND family_id = ?`, [memberId, familyId], (errMember, memberRow) => {
                if (errMember) return res.status(500).json({ error: 'Erro ao validar responsável pela conta' });
                if (!memberRow) return res.status(400).json({ error: 'Responsável inválido para esta família' });
                updateWithMember(memberId);
            });
        }
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
            triggerUpdate(familyId);
            res.json({ message: 'Conta excluída com sucesso' });
        });
    });
};
