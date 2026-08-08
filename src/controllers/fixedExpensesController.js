const db = require('../config/database');
const { getOrCreateWalletAccountId } = require('../utils/walletHelper');
const { triggerUpdate } = require('../services/financialEventService');

exports.getFixedExpenses = async (req, res) => {
    const familyId = req.user.family_id;
    const filterType = req.query.type;
    const month = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1;
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();

    // Convert filter month/year to a comparable date format (last day of the month) for start/end date checks
    const targetMonthEndStr = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    const targetMonthStartStr = `${year}-${String(month).padStart(2, '0')}-01`;

    let query = `
        SELECT rb.id, rb.name, rb.amount, rb.due_day, rb.is_auto_pay, rb.is_active, rb.category_id, rb.member_id, rb.account_id, rb.payment_type,
               rb.type, rb.total_installments, rb.current_installment, rb.start_date, rb.end_date,
               c.name as category_name, c.color_hex as category_color,
               (SELECT COUNT(*) FROM transactions t 
                WHERE t.recurring_bill_id = rb.id 
                AND MONTH(t.transaction_date) = ?
                AND YEAR(t.transaction_date) = ?
               ) as is_paid_this_month
        FROM recurring_bills rb
        JOIN categories c ON rb.category_id = c.id
        WHERE rb.family_id = ?
    `;
    const params = [month, year, familyId];

    if (filterType) {
        query += ` AND rb.type = ?`;
        params.push(filterType);
    }

    // Filter variables by date
    query += ` AND (
        rb.type != 'VARIABLE' OR 
        (
            (rb.start_date IS NULL OR rb.start_date <= ?) AND 
            (rb.end_date IS NULL OR rb.end_date >= ?)
        )
    )`;
    params.push(targetMonthEndStr, targetMonthStartStr);
    
    query += ` ORDER BY rb.due_day ASC`;

    const queryPromise = (q, p) => new Promise((resolve, reject) => {
        db.all(q, p, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        const rows = await queryPromise(query, params);

        const membersRows = await queryPromise(`SELECT id, name, avatar_url FROM members WHERE family_id = ?`, [familyId]);
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
                    statusColor: statusColor,
                    type: row.type || 'FIXED',
                    totalInstallments: row.total_installments,
                    currentInstallment: row.current_installment,
                    startDate: row.start_date,
                    endDate: row.end_date,
                    installmentLabel: row.total_installments ? `Parcela ${row.current_installment}/${row.total_installments}` : null
                };
            });
            // Fetch Credit Cards and sum their transactions for the month
            const creditCards = await queryPromise(`
                SELECT id, name, closing_day, due_day, color_hex
                FROM accounts 
                WHERE family_id = ? AND is_credit = 1
            `, [familyId]);

            for (const card of creditCards) {
                // Calculate billing cycle start and end based on requested month/year
                // For simplicity, we consider transactions where the month/year matches the "fatura" month
                // Emulating statisticsController logic:
                // Se fechamento = 15. Transações a partir de 15 do mes M-1 ate 14 do mes M entram na fatura do mes M se due_day > 15
                // Simplest approach right now to match the "Termometro" is exact same logic as homeController:
                // We sum where DATE_FORMAT is current, or we use the custom logic:
                const cardTransactions = await queryPromise(`
                    SELECT SUM(amount) as total_spent
                    FROM transactions 
                    WHERE account_id = ? AND type = 'EXPENSE'
                    AND (
                        (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) < COALESCE(?, 31) AND COALESCE(?, 1) >= COALESCE(?, 31))
                        OR 
                        (
                            (
                                (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) >= COALESCE(?, 31))
                                OR 
                                (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) < COALESCE(?, 31))
                            )
                            AND COALESCE(?, 1) < COALESCE(?, 31)
                        )
                    )
                `, [
                    card.id,
                    month, year, card.closing_day, card.due_day, card.closing_day,
                    month === 1 ? 12 : month - 1, month === 1 ? year - 1 : year, card.closing_day,
                    month, year, card.closing_day,
                    card.due_day, card.closing_day
                ]);

                // Also subtract INCOME (refunds)
                const cardIncomes = await queryPromise(`
                    SELECT SUM(amount) as total_refund
                    FROM transactions 
                    WHERE account_id = ? AND type = 'INCOME'
                    AND (
                        (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) < COALESCE(?, 31) AND COALESCE(?, 1) >= COALESCE(?, 31))
                        OR 
                        (
                            (
                                (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) >= COALESCE(?, 31))
                                OR 
                                (MONTH(transaction_date) = ? AND YEAR(transaction_date) = ? AND DAY(transaction_date) < COALESCE(?, 31))
                            )
                            AND COALESCE(?, 1) < COALESCE(?, 31)
                        )
                    )
                `, [
                    card.id,
                    month, year, card.closing_day, card.due_day, card.closing_day,
                    month === 1 ? 12 : month - 1, month === 1 ? year - 1 : year, card.closing_day,
                    month, year, card.closing_day,
                    card.due_day, card.closing_day
                ]);

                const spent = (cardTransactions[0].total_spent || 0) - (cardIncomes[0].total_refund || 0);

                if (spent > 0) {
                    const today = new Date();
                    const currentDay = today.getDate();
                    let invoiceStatus = 'Pendente';
                    let invoiceColor = '#2196F3';

                    if (card.due_day) {
                        if (card.due_day < currentDay) {
                            invoiceStatus = 'Atrasado';
                            invoiceColor = '#F44336';
                        } else if (card.due_day - currentDay <= 5 && card.due_day - currentDay >= 0) {
                            invoiceStatus = 'Vence em breve';
                            invoiceColor = '#FF9800';
                        }
                    }

                    expenses.push({
                        id: `invoice_${card.id}`,
                        title: `Fatura - ${card.name}`,
                        amount: spent,
                        rawAmount: spent,
                        dueDate: card.due_day ? `Dia ${card.due_day}` : 'S/ Data',
                        dueDay: card.due_day || 31,
                        isAutoPay: false,
                        isActive: true,
                        categoryId: null,
                        categoryName: 'Cartão de Crédito',
                        categoryColor: card.color_hex || '#9E9E9E',
                        memberId: null,
                        accountId: card.id,
                        paymentType: 'CREDIT_CARD',
                        ownerName: 'Casa',
                        ownerAvatars: [],
                        status: invoiceStatus,
                        statusColor: invoiceColor,
                        type: 'CREDIT_INVOICE'
                    });
                }
            }
            
            // Sort expenses again to include invoices in the correct due day order
            expenses.sort((a, b) => a.dueDay - b.dueDay);

            res.json({ expenses });
    } catch (err) {
        console.error('Erro ao buscar contas fixas:', err);
        return res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

exports.createFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    let { name, amount, dueDay, isAutoPay, categoryId, memberId, accountId, paymentType, type, totalInstallments, startDate } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const expenseType = type || 'FIXED';
    let endDate = null;
    let currentInstallment = 1;

    if (totalInstallments) {
        const start = startDate ? new Date(startDate) : new Date();
        const end = new Date(start);
        end.setMonth(end.getMonth() + parseInt(totalInstallments));
        endDate = end.toISOString().split('T')[0];
    }

    const query = `
        INSERT INTO recurring_bills (family_id, member_id, category_id, name, amount, due_day, is_auto_pay, account_id, payment_type, type, total_installments, current_installment, start_date, end_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        paymentType || null,
        expenseType,
        totalInstallments || null,
        currentInstallment,
        startDate || null,
        endDate
    ];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Erro ao criar conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao criar conta fixa' });
        }
        triggerUpdate(familyId);
        res.status(201).json({ message: 'Conta fixa criada com sucesso', id: this.lastID });
    });
};

exports.updateFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;
    let { name, amount, dueDay, isAutoPay, isActive, categoryId, memberId, accountId, paymentType, type, totalInstallments, currentInstallment, startDate, endDate } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const query = `
        UPDATE recurring_bills 
        SET name = ?, amount = ?, due_day = ?, is_auto_pay = ?, is_active = ?, category_id = ?, member_id = ?, account_id = ?, payment_type = ?,
            type = ?, total_installments = ?, current_installment = ?, start_date = ?, end_date = ?
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
        type || 'FIXED',
        totalInstallments || null,
        currentInstallment || 1,
        startDate || null,
        endDate || null,
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
        triggerUpdate(familyId);
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
        triggerUpdate(familyId);
        res.json({ message: 'Conta fixa excluída com sucesso' });
    });
};

exports.getUnlinkedTransactions = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT t.id, t.description, t.amount, t.transaction_date, a.name as account_name
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE a.family_id = ? 
          AND t.type = 'EXPENSE'
          AND t.recurring_bill_id IS NULL
          AND MONTH(t.transaction_date) = MONTH(CURRENT_DATE())
          AND YEAR(t.transaction_date) = YEAR(CURRENT_DATE())
        ORDER BY t.transaction_date DESC, t.id DESC
    `;

    db.all(query, [familyId], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar transações não vinculadas:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }
        res.json({ transactions: rows });
    });
};

exports.linkTransaction = (req, res) => {
    const familyId = req.user.family_id;
    const { transactionId, recurringBillId } = req.body;

    if (!transactionId || !recurringBillId) {
        return res.status(400).json({ error: 'transactionId e recurringBillId são obrigatórios' });
    }

    const checkQuery = `
        SELECT t.id as tx_id, a.family_id as tx_family_id, rb.id as rb_id, rb.family_id as rb_family_id
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        JOIN recurring_bills rb ON rb.id = ?
        WHERE t.id = ?
    `;

    db.get(checkQuery, [recurringBillId, transactionId], (err, row) => {
        if (err) {
            console.error('Erro ao verificar permissão de vínculo:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        if (!row) {
            return res.status(404).json({ error: 'Transação ou conta fixa não encontrada' });
        }

        if (row.tx_family_id !== familyId || row.rb_family_id !== familyId) {
            return res.status(403).json({ error: 'Operação não permitida' });
        }

        db.run(`UPDATE transactions SET recurring_bill_id = ? WHERE id = ?`, [recurringBillId, transactionId], function(errUpdate) {
            if (errUpdate) {
                console.error('Erro ao atualizar transação com o ID da conta fixa:', errUpdate);
                return res.status(500).json({ error: 'Erro ao vincular pagamento' });
            }

            db.get(`SELECT type, total_installments, current_installment FROM recurring_bills WHERE id = ? AND family_id = ?`, [recurringBillId, familyId], (errCheck, billRow) => {
                if (errCheck) console.error('Erro ao verificar parcela de conta variável:', errCheck);
                
                if (billRow && billRow.type === 'VARIABLE' && billRow.total_installments !== null) {
                    db.run(`UPDATE recurring_bills SET current_installment = current_installment + 1 WHERE id = ? AND type = 'VARIABLE'`, [recurringBillId], function(errInc) {
                        if (errInc) console.error('Erro ao incrementar parcela:', errInc);
                        
                        db.run(`UPDATE recurring_bills SET is_active = 0 WHERE id = ? AND current_installment > total_installments`, [recurringBillId], function(errDeac) {
                            if (errDeac) console.error('Erro ao desativar conta variável:', errDeac);
                            emitUpdateAndRespond();
                        });
                    });
                } else {
                    emitUpdateAndRespond();
                }
            });

            function emitUpdateAndRespond() {
                const { getIo } = require('../websockets/socket');
                const io = getIo();
                if (io) {
                    io.to(`family_${familyId}`).emit('data_updated', {
                        source: 'fixed_expenses',
                        action: 'linked'
                    });
                }
                triggerUpdate(familyId);
                res.json({ message: 'Pagamento vinculado com sucesso!' });
            }
        });
    });
};
