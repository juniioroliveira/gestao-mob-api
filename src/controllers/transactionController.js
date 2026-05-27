const db = require('../config/database');
const { getIo } = require('../websockets/socket');
const { getOrCreateWalletAccountId } = require('../utils/walletHelper');

const runQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

exports.createTransaction = async (req, res) => {
    let { accountId, destinationAccountId, categoryId, amount, type, description, date, memberId: reqMemberId, paymentType } = req.body;
    
    // Se o usuário não enviou o memberId ou não for admin, usa o próprio ID dele
    const memberId = reqMemberId || req.user.id;
    const familyId = req.user.family_id;

    const finalPaymentType = paymentType || 'DEBIT';
    if (finalPaymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!accountId || !amount || !type || !description || !date) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    }

    if (type !== 'TRANSFER' && !categoryId) {
        return res.status(400).json({ error: 'Categoria é obrigatória para despesas e receitas' });
    }

    if (type === 'TRANSFER' && (!destinationAccountId || accountId === destinationAccountId)) {
        return res.status(400).json({ error: 'Conta de destino inválida para transferência' });
    }

    const finalPaymentType = paymentType || 'DEBIT';
    const totalInstallments = req.body.installments ? parseInt(req.body.installments, 10) : 1;
    const isInstallment = totalInstallments > 1;
    const installmentGroupId = isInstallment ? `GRP_${Date.now()}_${Math.floor(Math.random()*1000)}` : null;
    const installmentAmount = isInstallment ? (amount / totalInstallments).toFixed(2) : amount;

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
        const baseDate = new Date(date);
        // Adiciona timezone offset para evitar voltar um dia dependendo do fuso
        baseDate.setMinutes(baseDate.getMinutes() + baseDate.getTimezoneOffset());
        let firstResultId = null;

        for (let i = 1; i <= totalInstallments; i++) {
            const currentDate = new Date(baseDate);
            currentDate.setMonth(currentDate.getMonth() + (i - 1));
            // Volta para a string YYYY-MM-DD
            const yyyy = currentDate.getFullYear();
            const mm = String(currentDate.getMonth() + 1).padStart(2, '0');
            const dd = String(currentDate.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}-${mm}-${dd}`;
            
            const desc = isInstallment ? `${description} (${i}/${totalInstallments})` : description;

            const insertQuery = `
                INSERT INTO transactions (account_id, destination_account_id, member_id, category_id, amount, type, description, transaction_date, is_ai_processed, payment_type, installment_group_id, installment_number, total_installments)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const result = await runQuery(insertQuery, [
                accountId, 
                type === 'TRANSFER' ? destinationAccountId : null, 
                JSON.stringify(req.body.memberId), 
                type === 'TRANSFER' ? null : categoryId, 
                installmentAmount, 
                type, 
                desc, 
                dateStr, 
                false, 
                finalPaymentType,
                installmentGroupId,
                isInstallment ? i : null,
                isInstallment ? totalInstallments : null
            ]);
            if (i === 1) firstResultId = result.lastID;
        }

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

        res.status(201).json({ message: 'Transação criada com sucesso', id: firstResultId });
    } catch (err) {
        console.error('Erro ao adicionar transação:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

exports.updateTransaction = async (req, res) => {
    const transactionId = req.params.id;
    const familyId = req.user.family_id;
    let { accountId, destinationAccountId, categoryId, amount, type, description, date, paymentType } = req.body;

    const finalPaymentType = paymentType || 'DEBIT';
    if (finalPaymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!accountId || !amount || !type || !description || !date) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    }

    if (type !== 'TRANSFER' && !categoryId) {
        return res.status(400).json({ error: 'Categoria é obrigatória para despesas e receitas' });
    }

    if (type === 'TRANSFER' && (!destinationAccountId || accountId === destinationAccountId)) {
        return res.status(400).json({ error: 'Conta de destino inválida para transferência' });
    }

    const finalPaymentType = paymentType || 'DEBIT';

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
            SET account_id = ?, destination_account_id = ?, member_id = ?, category_id = ?, amount = ?, type = ?, description = ?, transaction_date = ?, payment_type = ?
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
            finalPaymentType,
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

exports.clearTransactions = async (req, res) => {
    const familyId = req.user.family_id;
    
    try {
        // 1. Verificar se o usuário é administrador
        const checkQuery = `SELECT is_admin FROM members WHERE id = ?`;
        const row = await new Promise((resolve, reject) => {
            db.get(checkQuery, [req.user.id], (err, res) => err ? reject(err) : resolve(res));
        });
        
        if (!row || !row.is_admin) {
            return res.status(403).json({ error: 'Apenas administradores podem limpar os lançamentos' });
        }

        // 2. Apagar todas as transações das contas pertencentes à família
        const deleteQuery = `
            DELETE FROM transactions 
            WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ?)
        `;
        await runQuery(deleteQuery, [familyId]);

        // 3. Zerar o saldo de todas as contas da família
        const updateQuery = `
            UPDATE accounts 
            SET current_balance = 0.00 
            WHERE family_id = ?
        `;
        await runQuery(updateQuery, [familyId]);

        // 4. Emitir evento WebSocket para atualizar a tela de todos da família
        const io = getIo();
        if (io) {
            io.to(`family_${familyId}`).emit('data_updated', {
                source: 'transactions',
                action: 'cleared'
            });
            io.to(`family_${familyId}`).emit('data_updated', {
                source: 'accounts',
                action: 'updated'
            });
        }

        res.json({ message: 'Todos os lançamentos foram limpos e os saldos foram zerados com sucesso' });
    } catch (err) {
        console.error('Erro ao limpar lançamentos:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};
