const db = require('../config/database');
const { getOrCreateWalletAccountId } = require('../utils/walletHelper');

exports.getFixedExpenses = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT rb.id, rb.name, rb.amount, rb.due_day, rb.is_auto_pay, rb.is_active, rb.category_id, rb.member_id, rb.account_id, rb.payment_type,
               c.name as category_name, c.color_hex as category_color,
               (SELECT COUNT(*) FROM transactions t 
                WHERE t.recurring_bill_id = rb.id 
                AND MONTH(t.transaction_date) = MONTH(CURRENT_DATE()) 
                AND YEAR(t.transaction_date) = YEAR(CURRENT_DATE())
               ) as is_paid_this_month
        FROM recurring_bills rb
        JOIN categories c ON rb.category_id = c.id
        WHERE rb.family_id = ?
        ORDER BY rb.due_day ASC
    `;

    db.all(query, [familyId], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar contas fixas:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        db.all(`SELECT id, name, avatar_url FROM members WHERE family_id = ?`, [familyId], (err2, membersRows) => {
            const members = membersRows || [];

            const expenses = rows.map(row => {
                let ownerName = 'Casa';
                let ownerAvatars = [];
                
                try {
                    if (row.member_id) {
                        const memIds = JSON.parse(row.member_id);
                        if (Array.isArray(memIds)) {
                            const foundMembers = memIds.map(id => members.find(m => m.id === id)).filter(Boolean);
                            if (foundMembers.length > 0) {
                                ownerName = foundMembers.map(m => m.name.split(' ')[0]).join(', ');
                                ownerAvatars = foundMembers.map(m => m.avatar_url).filter(Boolean);
                            }
                        } else {
                            const m = members.find(mem => mem.id === memIds);
                            if (m) {
                                ownerName = m.name.split(' ')[0];
                                if (m.avatar_url) ownerAvatars.push(m.avatar_url);
                            }
                        }
                    }
                } catch (e) {
                    const m = members.find(mem => mem.id == row.member_id);
                    if (m) {
                        ownerName = m.name.split(' ')[0];
                        if (m.avatar_url) ownerAvatars.push(m.avatar_url);
                    }
                }

                let status = 'Pendente';
                let statusColor = '#2196F3'; // Azul
                const today = new Date();
                const currentDay = today.getDate();
                
                if (row.is_paid_this_month > 0) {
                    status = 'Pago';
                    statusColor = '#4CAF50'; // Verde
                } else if (row.due_day < currentDay) {
                    status = 'Atrasado';
                    statusColor = '#F44336'; // Vermelho
                } else if (row.due_day - currentDay <= 5 && row.due_day - currentDay >= 0) {
                    status = 'Vence em breve';
                    statusColor = '#FF9800'; // Laranja
                }

                return {
                    id: row.id,
                    title: row.name,
                    amount: row.amount || 0.00,
                    rawAmount: row.amount,
                    dueDate: `Dia ${row.due_day}`,
                    dueDay: row.due_day,
                    isAutoPay: Boolean(row.is_auto_pay),
                    isActive: Boolean(row.is_active),
                    categoryId: row.category_id,
                    categoryName: row.category_name,
                    categoryColor: row.category_color,
                    memberId: row.member_id,
                    accountId: row.account_id,
                    paymentType: row.payment_type,
                    ownerName: ownerName,
                    ownerAvatars: ownerAvatars,
                    status: status,
                    statusColor: statusColor
                };
            });

            res.json({ expenses });
        });
    });
};

exports.createFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    let { name, amount, dueDay, isAutoPay, categoryId, memberId, accountId, paymentType } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const query = `
        INSERT INTO recurring_bills (family_id, member_id, category_id, name, amount, due_day, is_auto_pay, account_id, payment_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        familyId,
        memberId || null,
        categoryId,
        name,
        amount || null,
        dueDay,
        isAutoPay ? 1 : 0,
        accountId || null,
        paymentType || null
    ];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Erro ao criar conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao criar conta fixa' });
        }
        res.status(201).json({ message: 'Conta fixa criada com sucesso', id: this.lastID });
    });
};

exports.updateFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;
    let { name, amount, dueDay, isAutoPay, isActive, categoryId, memberId, accountId, paymentType } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const query = `
        UPDATE recurring_bills 
        SET name = ?, amount = ?, due_day = ?, is_auto_pay = ?, is_active = ?, category_id = ?, member_id = ?, account_id = ?, payment_type = ?
        WHERE id = ? AND family_id = ?
    `;
    const params = [
        name,
        amount || null,
        dueDay,
        isAutoPay ? 1 : 0,
        isActive !== undefined ? (isActive ? 1 : 0) : 1,
        categoryId,
        memberId || null,
        accountId || null,
        paymentType || null,
        expenseId,
        familyId
    ];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Erro ao atualizar conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao atualizar conta fixa' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Conta fixa não encontrada' });
        }
        res.json({ message: 'Conta fixa atualizada com sucesso' });
    });
};

exports.deleteFixedExpense = (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;

    const query = `DELETE FROM recurring_bills WHERE id = ? AND family_id = ?`;
    
    db.run(query, [expenseId, familyId], function(err) {
        if (err) {
            console.error('Erro ao excluir conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao excluir conta fixa' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Conta fixa não encontrada' });
        }
        res.json({ message: 'Conta fixa excluída com sucesso' });
    });
};
