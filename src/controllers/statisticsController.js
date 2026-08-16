const db = require('../config/database');
const { getIo } = require('../websockets/socket');
const { triggerUpdate } = require('../services/financialEventService');

// transactions.member_id vem como um int solto, string de int, ou array JSON tipo
// "[1,2]" pra transação rateada entre membros. Mesmo parsing usado em outros
// controllers (contas fixas, home) — mantém o critério de "rateio" consistente.
function parseMemberIds(memberIdRaw) {
    if (memberIdRaw === null || memberIdRaw === undefined) return [];
    try {
        const str = memberIdRaw.toString();
        if (str.startsWith('[')) {
            const parsed = JSON.parse(str);
            return Array.isArray(parsed) ? parsed.map(Number) : [];
        }
        const n = parseInt(str, 10);
        return isNaN(n) ? [] : [n];
    } catch (e) {
        return [];
    }
}

exports.getStatisticsData = (req, res) => {
    const familyId = req.user.family_id;
    // scope=family: mesmo padrão usado em /api/fixed-expenses — telas que comparam
    // ou somam entre membros (ex: "Controle por Categoria" da Carteira) pedem isso
    // pra ver o gasto e a renda da família inteira, não só do usuário logado. Sem
    // o parâmetro, comportamento continua idêntico ao de sempre (só o próprio usuário).
    const familyScope = req.query.scope === 'family';
    const currentUserId = familyScope ? null : req.user.id;

    // Pega o mês e ano da query string ou usa o atual por padrão
    const reqMonth = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1;
    const reqYear = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    
    const currentMonth = reqMonth; // 1 a 12
    const currentYear = reqYear;

    const monthStr = currentMonth.toString().padStart(2, '0');
    const yearStr = currentYear.toString();
    const targetMonthStr = `${yearStr}-${monthStr}`;

    // Categorias + orçamento do mês. O limite é um PERCENTUAL da renda (de quem está
    // vendo), não mais um valor em R$ travado — "spent" e o R$ do limite são
    // recalculados mais abaixo, depois que soubermos a renda relevante.
    const query = `
        SELECT
            c.id, c.name, c.color_hex, c.icon, c.type,
            cb.budget_percent
        FROM categories c
        LEFT JOIN category_budgets cb ON c.id = cb.category_id AND cb.month = ? AND cb.year = ?
        WHERE c.family_id = ?
    `;

    const runMainQuery = () => {
        db.all(query, [currentMonth, currentYear, familyId], (err, rows) => {
            if (err) {
                console.error('Erro ao buscar estatísticas:', err);
                return res.status(500).json({ error: 'Erro interno no servidor' });
            }

            const categoriesMeta = rows.map(row => ({
                id: row.id,
                name: row.name,
                color: row.color_hex || '#CCCCCC',
                icon: row.icon || 'category',
                type: row.type || 'EXPENSE',
                percent: row.budget_percent != null ? Number(row.budget_percent) : 0,
            }));

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

                    // Por usuário: só entra transação em que o usuário logado está entre os
                    // donos — sem member_id definido não existe pra transação (sempre tem um
                    // responsável), mas se for rateada (array com vários ids) ainda aparece
                    // normalmente pra todo mundo que está nela. Em scope=family, todo mundo entra.
                    const myTransactionsRows = familyScope
                        ? transactionsRows
                        : transactionsRows.filter(t => parseMemberIds(t.member_id).includes(currentUserId));

                    const finalTransactions = myTransactionsRows.map(t => {
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

                    // Recalcula "spent" por categoria e o total de despesas a partir das
                    // transações já filtradas por usuário (rateio: se a transação é
                    // compartilhada com outro membro, conta o valor cheio mesmo assim, pois
                    // representa o gasto real que passou pela conta do usuário).
                    let totalExpense = 0;
                    const spentByCategory = {};
                    myTransactionsRows.forEach(t => {
                        if (t.type !== 'EXPENSE') return;
                        const amount = Number(t.amount) || 0;
                        totalExpense += amount;
                        if (t.category_id != null) {
                            spentByCategory[t.category_id] = (spentByCategory[t.category_id] || 0) + amount;
                        }
                    });
                    // Renda declarada — só a do usuário logado, não a soma da família (a
                    // menos que seja scope=family, aí soma todo mundo). O limite de cada
                    // categoria (em R$) é sempre o percentual salvo aplicado sobre ESSA
                    // renda, calculado na hora — nunca um valor travado no banco.
                    const incomeQuery = familyScope
                        ? `SELECT COALESCE(SUM(monthly_income), 0) as totalIncome FROM members WHERE family_id = ?`
                        : `SELECT COALESCE(monthly_income, 0) as totalIncome FROM members WHERE family_id = ? AND id = ?`;
                    const incomeParams = familyScope ? [familyId] : [familyId, currentUserId];
                    db.get(incomeQuery, incomeParams, (err3, incomeRow) => {
                        if (err3) {
                            console.error('Erro ao buscar receitas na estatística:', err3);
                            return res.status(500).json({ error: 'Erro interno no servidor' });
                        }

                        const totalIncome = incomeRow ? incomeRow.totalIncome : 0;
                        const categories = categoriesMeta.map(cat => {
                            const spent = spentByCategory[cat.id] || 0;
                            const limit = (cat.percent / 100) * totalIncome;
                            return {
                                ...cat,
                                spent,
                                limit,
                                percentage: limit > 0 ? (spent / limit) : 0
                            };
                        });

                        res.json({
                            totalExpense,
                            totalIncome,
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
    const { name, color, icon, type, percent } = req.body;

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    if (!name) return res.status(400).json({ error: 'O nome da categoria é obrigatório' });

    const insertQuery = `INSERT INTO categories (family_id, name, type, color_hex, icon) VALUES (?, ?, ?, ?, ?)`;

    db.run(insertQuery, [familyId, name, type || 'EXPENSE', color || '#CCCCCC', icon || 'category'], function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao criar categoria' });

        const categoryId = this.lastID;

        // Se um percentual foi enviado, salva na tabela de orçamentos para o mês atual.
        // O limite em R$ é sempre derivado desse percentual na hora de exibir, nunca
        // gravado como valor fixo aqui.
        if (percent !== undefined && percent >= 0) {
            db.run(
                `INSERT INTO category_budgets (category_id, month, year, budget_percent) VALUES (?, ?, ?, ?)`,
                [categoryId, currentMonth, currentYear, percent],
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
    const { name, color, icon, percent } = req.body;

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
            if (percent !== undefined && percent >= 0) {
                // Atualiza ou insere o percentual para o mês atual (Upsert)
                const upsertLimit = `
                    INSERT INTO category_budgets (category_id, month, year, budget_percent)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(category_id, month, year) DO UPDATE SET budget_percent = excluded.budget_percent
                `;
                db.run(upsertLimit, [categoryId, currentMonth, currentYear, percent], (errLimit) => {
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
            const query = `UPDATE categories SET ${updates.join(', ')} WHERE id = ? AND family_id = ?`;
            params.push(familyId);
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

    // Confirma posse ANTES de apagar qualquer coisa — apagar category_budgets primeiro
    // sem checar a família permitiria apagar orçamento de categoria de outra família
    // mesmo que a exclusão da categoria em si fosse bloqueada logo em seguida.
    db.get(`SELECT id FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], (errCheck, row) => {
        if (errCheck) return res.status(500).json({ error: 'Erro interno no servidor' });
        if (!row) return res.status(404).json({ error: 'Categoria não encontrada' });

        db.run(`DELETE FROM category_budgets WHERE category_id = ?`, [categoryId], (err) => {
            if (err) console.error('Erro ao deletar orçamentos:', err);

            db.run(`DELETE FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], function(err2) {
                if (err2) {
                    // category_id em transactions/recurring_bills é ON DELETE RESTRICT —
                    // categoria em uso não pode ser excluída; dá pra reconhecer isso pelo
                    // código do erro do MySQL em vez de devolver um 500 genérico.
                    const isInUse = err2.code === 'ER_ROW_IS_REFERENCED_2' || err2.code === 'ER_ROW_IS_REFERENCED' || err2.errno === 1451;
                    if (isInUse) {
                        return res.status(409).json({ error: 'Essa categoria tem transações ou contas fixas vinculadas e não pode ser excluída.' });
                    }
                    return res.status(500).json({ error: 'Erro ao excluir categoria' });
                }
                if (this.changes === 0) return res.status(404).json({ error: 'Categoria não encontrada' });

                getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'deleted' });
                triggerUpdate(familyId);
                res.json({ message: 'Categoria excluída com sucesso' });
            });
        });
    });
};

// Reserva mínima de sobra que a sugestão sempre protege — nunca sugere limites
// que, somados, deixem a família sem margem nenhuma no fim do mês.
const SUGGESTION_MINIMUM_SAVINGS_PERCENT = 10;

const suggestionGetQuery = (query, params) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const suggestionGetOne = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});

// Sugestão de % ao abrir "Editar Categoria" — cálculo direto (sem chamada de IA
// a cada abertura: instantâneo e sem custo). NÃO é "quanto você já gasta" — isso
// só validaria um estouro existente. É "quanto dá pra reservar aqui sem
// comprometer terminar o mês com saldo": renda − contas fixas já pendentes −
// reserva mínima − % que outras categorias já reservaram = o que sobra pra
// dividir entre as categorias ainda sem limite, pesado pelo histórico de gasto
// relativo ENTRE ELAS (quem gasta mais puxa mais fatia desse pool sustentável,
// mas o pool em si já nasce dentro do que é saudável, não do total gasto hoje).
exports.getSuggestedCategoryPercent = async (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = parseInt(req.params.id, 10);
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    try {
        const category = await suggestionGetOne(`SELECT id, type FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId]);
        if (!category) return res.status(404).json({ error: 'Categoria não encontrada' });

        // Só despesa tem sentido de "limite" — receita não tem meta (mesma decisão
        // já tomada quando tiramos a obrigatoriedade de categoria em lançamento de receita).
        if (category.type !== 'EXPENSE') {
            return res.json({ suggestedPercent: 0, reason: 'not_applicable' });
        }

        const incomeRow = await suggestionGetOne(`SELECT COALESCE(SUM(monthly_income), 0) as totalIncome FROM members WHERE family_id = ?`, [familyId]);
        const totalIncome = incomeRow.totalIncome || 0;
        if (totalIncome <= 0) {
            return res.json({ suggestedPercent: 0, reason: 'no_income' });
        }

        // Todas as categorias de despesa da família com o % já configurado (ou 0).
        const allCategories = await suggestionGetQuery(
            `SELECT c.id, COALESCE(cb.budget_percent, 0) as percent
             FROM categories c
             LEFT JOIN category_budgets cb ON cb.category_id = c.id AND cb.month = ? AND cb.year = ?
             WHERE c.family_id = ? AND c.type = 'EXPENSE'`,
            [currentMonth, currentYear, familyId]
        );

        const alreadySetPercent = allCategories
            .filter(c => c.id !== categoryId && c.percent > 0)
            .reduce((s, c) => s + c.percent, 0);

        const unsetCategoryIds = allCategories.filter(c => c.percent <= 0).map(c => c.id);
        if (!unsetCategoryIds.includes(categoryId)) unsetCategoryIds.push(categoryId);

        // Contas fixas pendentes do mês (compromisso já assumido, família inteira —
        // mesmo escopo já usado no resto de "Controle por Categoria").
        const { computeExpensesForMonth } = require('./fixedExpensesController');
        const fixedExpenses = await computeExpensesForMonth(familyId, currentMonth, currentYear, null, null);
        const fixedBillsTotal = fixedExpenses.filter(e => e.status !== 'Pago').reduce((s, e) => s + (e.amount || 0), 0);
        const fixedBillsPercent = (fixedBillsTotal / totalIncome) * 100;

        const availableDiscretionaryPercent = 100 - fixedBillsPercent - SUGGESTION_MINIMUM_SAVINGS_PERCENT;
        const remainingPoolPercent = Math.max(0, availableDiscretionaryPercent - alreadySetPercent);

        if (remainingPoolPercent <= 0) {
            // Já não sobra nada saudável pra reservar — contas fixas + o que já foi
            // configurado nas outras categorias já tomam a renda inteira (ou mais).
            return res.json({ suggestedPercent: 0, remainingPoolPercent: 0, reason: 'no_room' });
        }

        // Histórico (últimos 3 meses) só das categorias AINDA sem limite — decide o
        // peso relativo de cada uma dentro do pool sustentável, não o valor absoluto.
        const placeholders = unsetCategoryIds.map(() => '?').join(',');
        const histRows = await suggestionGetQuery(
            `SELECT t.category_id,
                    SUM(t.amount) as total,
                    COUNT(DISTINCT DATE_FORMAT(t.transaction_date, '%Y-%m')) as months
             FROM transactions t
             JOIN accounts a ON t.account_id = a.id
             WHERE a.family_id = ? AND t.type = 'EXPENSE' AND t.category_id IN (${placeholders})
               AND t.transaction_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 2 MONTH), '%Y-%m-01')
             GROUP BY t.category_id`,
            [familyId, ...unsetCategoryIds]
        );

        const avgByCategory = {};
        histRows.forEach(r => {
            avgByCategory[r.category_id] = r.months > 0 ? (r.total || 0) / r.months : 0;
        });
        const totalUnsetAvgSpend = Object.values(avgByCategory).reduce((s, v) => s + v, 0);

        let suggestedPercent;
        if (totalUnsetAvgSpend > 0) {
            const thisAvg = avgByCategory[categoryId] || 0;
            suggestedPercent = (thisAvg / totalUnsetAvgSpend) * remainingPoolPercent;
        } else {
            // Nenhuma das categorias sem limite tem histórico — reparte em partes iguais.
            suggestedPercent = remainingPoolPercent / unsetCategoryIds.length;
        }

        suggestedPercent = Math.min(100, Math.max(0, Math.round(suggestedPercent)));

        res.json({
            suggestedPercent,
            remainingPoolPercent: Math.round(remainingPoolPercent),
            reason: 'ok'
        });
    } catch (err) {
        console.error('Erro ao calcular sugestão de % de categoria:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};
