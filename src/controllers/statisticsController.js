const db = require('../config/database');
const { getIo } = require('../websockets/socket');
const { triggerUpdate } = require('../services/financialEventService');

exports.getStatisticsData = (req, res) => {
    const familyId = req.user.family_id;
    
    // Pega o mês e ano da query string ou usa o atual por padrão
    const reqMonth = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1;
    const reqYear = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    
    const currentMonth = reqMonth; // 1 a 12
    const currentYear = reqYear;

    const monthStr = currentMonth.toString().padStart(2, '0');
    const yearStr = currentYear.toString();
    const targetMonthStr = `${yearStr}-${monthStr}`;

    // Query para obter os gastos por categoria e os orçamentos
    const query = `
        SELECT 
            c.id, c.name, c.color_hex, c.icon, c.type,
            COALESCE(cb.budget_limit, 0) as budget_limit,
            COALESCE(SUM(t_filtered.amount), 0) as spent
        FROM categories c
        LEFT JOIN category_budgets cb ON c.id = cb.category_id AND cb.month = ? AND cb.year = ?
        LEFT JOIN (
            SELECT t.category_id, t.amount
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE t.type = 'EXPENSE' AND DATE_FORMAT(
                 CASE 
                     WHEN a.type = 'CREDIT' THEN
                         DATE_ADD(
                             t.transaction_date, 
                             INTERVAL (
                                 (CASE WHEN DAY(t.transaction_date) >= COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END) +
                                 (CASE WHEN COALESCE(a.due_day, 1) < COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END)
                             ) MONTH
                         )
                     ELSE t.transaction_date 
                 END, 
                 '%Y-%m'
            ) = ?
        ) t_filtered ON c.id = t_filtered.category_id
        WHERE c.family_id = ?
        GROUP BY c.id
    `;

    const runMainQuery = () => {
        db.all(query, [currentMonth, currentYear, targetMonthStr, familyId], (err, rows) => {
            if (err) {
                console.error('Erro ao buscar estatísticas:', err);
                return res.status(500).json({ error: 'Erro interno no servidor' });
            }

            let totalExpense = 0;
            const categories = rows.map(row => {
                totalExpense += row.spent;
                return {
                    id: row.id,
                    name: row.name,
                    color: row.color_hex || '#CCCCCC',
                    icon: row.icon || 'category',
                    type: row.type || 'EXPENSE',
                    limit: row.budget_limit,
                    spent: row.spent,
                    percentage: row.budget_limit > 0 ? (row.spent / row.budget_limit) : 0
                };
            });

            // Buscar histórico de transações do mês
            const transactionsQuery = `
                SELECT t.id, t.amount, t.type, t.description, t.transaction_date, 
                       t.account_id, t.destination_account_id, t.category_id, t.member_id, t.payment_type, t.recurring_bill_id,
                       a.name as account_name, 
                       c.icon, c.color_hex 
                FROM transactions t 
                JOIN accounts a ON t.account_id = a.id 
                LEFT JOIN categories c ON t.category_id = c.id 
                WHERE a.family_id = ? 
                  AND DATE_FORMAT(
                     CASE 
                         WHEN a.type = 'CREDIT' THEN
                             DATE_ADD(
                                 t.transaction_date, 
                                 INTERVAL (
                                     (CASE WHEN DAY(t.transaction_date) >= COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END) +
                                     (CASE WHEN COALESCE(a.due_day, 1) < COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END)
                                 ) MONTH
                             )
                         ELSE t.transaction_date 
                     END, 
                     '%Y-%m'
                  ) = ?
                ORDER BY t.transaction_date DESC, t.id DESC
            `;

            db.all(transactionsQuery, [familyId, targetMonthStr], (err2, transactionsRows) => {
                if (err2) {
                    console.error('Erro ao buscar transações na estatística:', err2);
                    return res.status(500).json({ error: 'Erro interno no servidor' });
                }

                // Precisamos buscar os membros para mapear os nomes
                db.all(`SELECT id, name FROM members WHERE family_id = ?`, [familyId], (err4, membersRows) => {
                    const members = membersRows || [];
                    const finalTransactions = transactionsRows.map(t => {
                        let memberName = 'Desconhecido';
                        try {
                            const memIds = JSON.parse(t.member_id);
                            if (Array.isArray(memIds)) {
                                const names = memIds.map(id => {
                                    const m = members.find(mem => mem.id === id);
                                    return m ? m.name.split(' ')[0] : '';
                                }).filter(Boolean);
                                memberName = names.length > 1 ? names.join(', ') : (names[0] || 'Desconhecido');
                            } else {
                                const m = members.find(mem => mem.id === memIds);
                                memberName = m ? m.name : 'Desconhecido';
                            }
                        } catch (e) {
                            const m = members.find(mem => mem.id === t.member_id);
                            memberName = m ? m.name : 'Desconhecido';
                        }
                        return { ...t, member_name: memberName };
                    });

                    // Buscar receita total do mês baseada na previsão de renda dos membros da família
                    const incomeQuery = `
                        SELECT COALESCE(SUM(COALESCE(monthly_income, 0) + COALESCE(advance_value, 0)), 0) as totalIncome
                        FROM members
                        WHERE family_id = ?
                    `;
                    db.get(incomeQuery, [familyId], (err3, incomeRow) => {
                        if (err3) {
                            console.error('Erro ao buscar receitas na estatística:', err3);
                            return res.status(500).json({ error: 'Erro interno no servidor' });
                        }

                        res.json({
                            totalExpense,
                            totalIncome: incomeRow ? incomeRow.totalIncome : 0,
                            categories,
                            transactions: finalTransactions
                        });
                    });
                });
            });
        });
    };

    // Auto-correção: garante que a família tenha pelo menos uma categoria INCOME.
    // Se não tiver, promove 'Salário' (ou similar) para INCOME.
    db.get(
        `SELECT COUNT(*) as count FROM categories WHERE family_id = ? AND type = 'INCOME'`,
        [familyId],
        (errCheck, checkRow) => {
            if (!errCheck && checkRow && checkRow.count === 0) {
                db.run(
                    `UPDATE categories SET type = 'INCOME' 
                     WHERE family_id = ? 
                       AND (LOWER(name) LIKE 'salário%' OR LOWER(name) LIKE 'salario%' OR LOWER(name) = 'receita' OR LOWER(name) = 'renda')`,
                    [familyId],
                    (errUpd) => {
                        if (errUpd) console.error('Erro ao promover categoria para INCOME:', errUpd);
                        runMainQuery();
                    }
                );
            } else {
                runMainQuery();
            }
        }
    );
};

exports.createCategory = (req, res) => {
    const familyId = req.user.family_id;
    const { name, color, icon, type, limit } = req.body;
    
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    if (!name) return res.status(400).json({ error: 'O nome da categoria é obrigatório' });

    const insertQuery = `INSERT INTO categories (family_id, name, type, color_hex, icon) VALUES (?, ?, ?, ?, ?)`;
    
    db.run(insertQuery, [familyId, name, type || 'EXPENSE', color || '#CCCCCC', icon || 'category'], function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao criar categoria' });
        
        const categoryId = this.lastID;
        
        // Se um limite foi enviado, salva na tabela de orçamentos para o mês atual
        if (limit !== undefined && limit >= 0) {
            db.run(
                `INSERT INTO category_budgets (category_id, month, year, budget_limit) VALUES (?, ?, ?, ?)`,
                [categoryId, currentMonth, currentYear, limit],
                (err2) => {
                    if (err2) console.error('Erro ao salvar limite', err2);
                    getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'created' });
                    triggerUpdate(familyId);
                    res.status(201).json({ message: 'Categoria criada com limite', id: categoryId });
                }
            );
        } else {
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'created' });
            triggerUpdate(familyId);
            res.status(201).json({ message: 'Categoria criada', id: categoryId });
        }
    });
};

exports.updateCategory = (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = req.params.id;
    const { name, color, icon, limit } = req.body;
    
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    // Primeiro garante que a categoria pertence à família
    db.get(`SELECT id FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Categoria não encontrada ou sem permissão' });

        const updates = [];
        const params = [];
        
        if (name) { updates.push('name = ?'); params.push(name); }
        if (color) { updates.push('color_hex = ?'); params.push(color); }
        if (icon) { updates.push('icon = ?'); params.push(icon); }
        
        const updateCategoryAndLimit = () => {
            if (limit !== undefined && limit >= 0) {
                // Atualiza ou insere o limite para o mês atual (Upsert)
                const upsertLimit = `
                    INSERT INTO category_budgets (category_id, month, year, budget_limit)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(category_id, month, year) DO UPDATE SET budget_limit = excluded.budget_limit
                `;
                db.run(upsertLimit, [categoryId, currentMonth, currentYear, limit], (errLimit) => {
                    if (errLimit) console.error('Erro ao atualizar limite', errLimit);
                    getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'updated' });
                    triggerUpdate(familyId);
                    res.json({ message: 'Categoria e limite atualizados' });
                });
            } else {
                getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'updated' });
                triggerUpdate(familyId);
                res.json({ message: 'Categoria atualizada' });
            }
        };

        if (updates.length > 0) {
            params.push(categoryId);
            const query = `UPDATE categories SET ${updates.join(', ')} WHERE id = ?`;
            db.run(query, params, (errUpdate) => {
                if (errUpdate) return res.status(500).json({ error: 'Erro ao atualizar dados básicos' });
                updateCategoryAndLimit();
            });
        } else {
            updateCategoryAndLimit();
        }
    });
};

exports.deleteCategory = (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = req.params.id;

    db.run(`DELETE FROM category_budgets WHERE category_id = ?`, [categoryId], (err) => {
        if (err) console.error('Erro ao deletar orçamentos:', err);
        
        db.run(`DELETE FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], function(err2) {
            if (err2) return res.status(500).json({ error: 'Erro ao excluir categoria' });
            if (this.changes === 0) return res.status(404).json({ error: 'Categoria não encontrada' });
            
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'deleted' });
            triggerUpdate(familyId);
            res.json({ message: 'Categoria excluída com sucesso' });
        });
    });
};
