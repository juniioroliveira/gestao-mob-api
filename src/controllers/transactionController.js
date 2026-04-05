const db = require('../config/database');
const { getIo } = require('../websockets/socket');

const runQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

exports.createTransaction = async (req, res) => {
    const { accountId, destinationAccountId, categoryId, amount, type, description, date, memberId: reqMemberId } = req.body;
    
    // Se o usuário não enviou o memberId ou não for admin, usa o próprio ID dele
    const memberId = reqMemberId || req.user.id;
    const familyId = req.user.family_id;

    if (!accountId || !amount || !type || !description || !date) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    }

    if (type !== 'TRANSFER' && !categoryId) {
        return res.status(400).json({ error: 'Categoria é obrigatória para despesas e receitas' });
    }

    if (type === 'TRANSFER' && (!destinationAccountId || accountId === destinationAccountId)) {
        return res.status(400).json({ error: 'Conta de destino inválida para transferência' });
    }

    try {
        // Validação de segurança extra no backend:
        // Se ele estiver tentando lançar em nome de outro membro, verificar se é admin
        if (memberId !== req.user.id) {
            const checkQuery = `SELECT is_admin FROM members WHERE id = ?`;
            const row = await new Promise((resolve, reject) => {
                db.get(checkQuery, [req.user.id], (err, res) => err ? reject(err) : resolve(res));
            });
            if (!row || !row.is_admin) {
                return res.status(403).json({ error: 'Apenas administradores podem lançar transações em nome de outros membros' });
            }
        }

        // Inserir a transação (memberId agora vem como string JSON)
        const insertQuery = `
            INSERT INTO transactions (account_id, destination_account_id, member_id, category_id, amount, type, description, transaction_date, is_ai_processed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const result = await runQuery(insertQuery, [accountId, type === 'TRANSFER' ? destinationAccountId : null, JSON.stringify(req.body.memberId), type === 'TRANSFER' ? null : categoryId, amount, type, description, date, false]);

        // Atualizar saldos das contas
        if (type === 'EXPENSE') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
        } else if (type === 'INCOME') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
        } else if (type === 'TRANSFER') {
            // Tira da conta de origem
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
            // Coloca na conta de destino
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ? AND family_id = ?`, [amount, destinationAccountId, familyId]);
        }

        // Emitir evento de nova transação via WebSocket
        const io = getIo();
        if (io) {
            io.to(`family_${familyId}`).emit('data_updated', {
                source: 'transactions',
                action: 'created'
            });
        }

        res.status(201).json({ message: 'Transação criada com sucesso', id: result.lastID });
    } catch (err) {
        console.error('Erro ao adicionar transação:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

exports.updateTransaction = async (req, res) => {
    const transactionId = req.params.id;
    const familyId = req.user.family_id;
    const { accountId, destinationAccountId, categoryId, amount, type, description, date } = req.body;

    if (!accountId || !amount || !type || !description || !date) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    }

    if (type !== 'TRANSFER' && !categoryId) {
        return res.status(400).json({ error: 'Categoria é obrigatória para despesas e receitas' });
    }

    if (type === 'TRANSFER' && (!destinationAccountId || accountId === destinationAccountId)) {
        return res.status(400).json({ error: 'Conta de destino inválida para transferência' });
    }

    try {
        // 1. Pegar a transação antiga
        const oldTx = await new Promise((resolve, reject) => {
            db.get(
                `SELECT t.id, t.amount, t.type, t.account_id, t.destination_account_id, a.family_id 
                 FROM transactions t 
                 JOIN accounts a ON t.account_id = a.id 
                 WHERE t.id = ?`, 
                [transactionId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!oldTx) return res.status(404).json({ error: 'Transação não encontrada' });
        if (oldTx.family_id !== familyId) return res.status(403).json({ error: 'Sem permissão' });

        // 2. Reverter os saldos antigos
        if (oldTx.type === 'EXPENSE') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?`, [oldTx.amount, oldTx.account_id]);
        } else if (oldTx.type === 'INCOME') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ?`, [oldTx.amount, oldTx.account_id]);
        } else if (oldTx.type === 'TRANSFER') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?`, [oldTx.amount, oldTx.account_id]);
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ?`, [oldTx.amount, oldTx.destination_account_id]);
        }

        // 3. Atualizar a transação
        const updateQuery = `
            UPDATE transactions 
            SET account_id = ?, destination_account_id = ?, member_id = ?, category_id = ?, amount = ?, type = ?, description = ?, transaction_date = ?
            WHERE id = ?
        `;
        await runQuery(updateQuery, [
            accountId, 
            type === 'TRANSFER' ? destinationAccountId : null, 
            JSON.stringify(req.body.memberId),
            type === 'TRANSFER' ? null : categoryId, 
            amount, 
            type, 
            description, 
            date, 
            transactionId
        ]);

        // 4. Aplicar os novos saldos
        if (type === 'EXPENSE') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
        } else if (type === 'INCOME') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
        } else if (type === 'TRANSFER') {
            await runQuery(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ? AND family_id = ?`, [amount, accountId, familyId]);
            await runQuery(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ? AND family_id = ?`, [amount, destinationAccountId, familyId]);
        }

        // 5. Emitir evento WebSocket
        const io = getIo();
        if (io) {
            io.to(`family_${familyId}`).emit('data_updated', {
                source: 'transactions',
                action: 'updated'
            });
        }

        res.json({ message: 'Transação atualizada com sucesso' });
    } catch (err) {
        console.error('Erro ao atualizar transação:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

exports.deleteTransaction = (req, res) => {
    const transactionId = req.params.id;
    const familyId = req.user.family_id;

    // 1. Pegar detalhes da transação para reverter o saldo
    db.get(
        `SELECT t.id, t.amount, t.type, t.account_id, t.destination_account_id, a.family_id 
         FROM transactions t 
         JOIN accounts a ON t.account_id = a.id 
         WHERE t.id = ?`, 
        [transactionId], 
        (err, row) => {
            if (err) return res.status(500).json({ error: 'Erro interno' });
            if (!row) return res.status(404).json({ error: 'Transação não encontrada' });
            if (row.family_id !== familyId) return res.status(403).json({ error: 'Sem permissão' });

            // 2. Excluir a transação
            db.run(`DELETE FROM transactions WHERE id = ?`, [transactionId], function(err2) {
                if (err2) return res.status(500).json({ error: 'Erro ao excluir' });

                const emitUpdate = () => {
                    const io = getIo();
                    if (io) {
                        io.to(`family_${familyId}`).emit('data_updated', {
                            source: 'transactions',
                            action: 'deleted'
                        });
                    }
                };

                // 3. Reverter o saldo da conta
                if (row.type === 'EXPENSE') {
                    db.run(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?`, [row.amount, row.account_id], (err3) => {
                        if (err3) console.error('Erro ao reverter saldo:', err3);
                        emitUpdate();
                        res.json({ message: 'Transação excluída e saldo revertido' });
                    });
                } else if (row.type === 'INCOME') {
                    db.run(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ?`, [row.amount, row.account_id], (err3) => {
                        if (err3) console.error('Erro ao reverter saldo:', err3);
                        emitUpdate();
                        res.json({ message: 'Transação excluída e saldo revertido' });
                    });
                } else if (row.type === 'TRANSFER') {
                    db.run(`UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?`, [row.amount, row.account_id], (err3) => {
                        if (err3) console.error('Erro ao reverter saldo origem:', err3);
                        db.run(`UPDATE accounts SET current_balance = current_balance - ? WHERE id = ?`, [row.amount, row.destination_account_id], (err4) => {
                            if (err4) console.error('Erro ao reverter saldo destino:', err4);
                            emitUpdate();
                            res.json({ message: 'Transação excluída e saldos revertidos' });
                        });
                    });
                }
            });
        }
    );
};
