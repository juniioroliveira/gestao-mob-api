const db = require('../config/database');

exports.getWalletData = (req, res) => {
    const familyId = req.user.family_id;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const monthStr = new Date().toISOString().slice(0, 7); // YYYY-MM

    // 1. Pegar o saldo total das contas (apenas para o card do topo)
    const queryAccounts = `SELECT current_balance, type FROM accounts WHERE family_id = ? AND type != 'INVESTMENT'`;
    
    db.all(queryAccounts, [familyId], (err, accounts) => {
        if (err) return res.status(500).json({ error: 'Erro interno' });
        
        let totalBalance = 0;
        accounts.forEach(acc => totalBalance += acc.current_balance);

        // 2. Buscar todos os membros
        db.all(`SELECT id, name, avatar_url, monthly_income FROM members WHERE family_id = ?`, [familyId], (err, members) => {
            if (err) return res.status(500).json({ error: 'Erro interno' });

            const membersMap = {};
            members.forEach(m => {
                membersMap[m.id] = {
                    memberId: m.id,
                    memberName: m.name,
                    avatarUrl: m.avatar_url,
                    monthlyIncome: m.monthly_income,
                    totalSpent: 0,
                    individualSpent: 0,
                    categoriesMap: {}
                };
            });

            // 3. Buscar limites de orçamento da família para o mês atual
            const queryBudgets = `
                SELECT c.id, c.name, c.icon, c.color_hex, b.budget_limit 
                FROM categories c
                LEFT JOIN category_budgets b ON c.id = b.category_id AND b.month = ? AND b.year = ?
                WHERE c.family_id = ? AND c.type = 'EXPENSE'
            `;
            
            db.all(queryBudgets, [currentMonth, currentYear, familyId], (err, categories) => {
                if (err) return res.status(500).json({ error: 'Erro interno' });
                
                const categoryBudgets = {};
                categories.forEach(c => {
                    categoryBudgets[c.id] = {
                        categoryId: c.id,
                        name: c.name,
                        icon: c.icon,
                        colorHex: c.color_hex,
                        budgetLimit: c.budget_limit || 0,
                        familyTotalSpent: 0
                    };
                });

                // 4. Buscar transações do mês (apenas EXPENSE e TRANSFER)
                const queryTransactions = `
                    SELECT t.amount, t.member_id, t.category_id, t.type, a.type as account_type
                    FROM transactions t
                    JOIN accounts a ON t.account_id = a.id
                    WHERE a.family_id = ? AND t.type IN ('EXPENSE', 'TRANSFER') AND strftime('%Y-%m', t.transaction_date) = ?
                `;

                db.all(queryTransactions, [familyId, monthStr], (err, transactions) => {
                    if (err) return res.status(500).json({ error: 'Erro interno' });

                    let familyTotalExpenses = 0;

                    transactions.forEach(t => {
                        const amount = t.amount;
                        const catId = t.category_id;
                        
                        // Filtramos apenas as despesas reais para não duplicar com as transferências (pagamentos de fatura de cartão)
                        if (t.type === 'EXPENSE') {
                            familyTotalExpenses += amount;

                            // Atualiza o gasto total da família na categoria
                            if (catId && categoryBudgets[catId]) {
                                categoryBudgets[catId].familyTotalSpent += amount;
                            }

                            // Rateio do gasto entre os membros responsáveis
                            let owners = [];
                            try {
                                const parsed = JSON.parse(t.member_id);
                                if (Array.isArray(parsed)) owners = parsed;
                                else owners = [parsed];
                            } catch (e) {
                                if (t.member_id) owners = [parseInt(t.member_id)];
                            }

                            if (owners.length > 0) {
                                const share = amount / owners.length;
                                const isIndividual = owners.length === 1;

                                owners.forEach(owner => {
                                    if (owner && membersMap[owner]) {
                                        membersMap[owner].totalSpent += share;
                                        if (isIndividual) {
                                            membersMap[owner].individualSpent += share;
                                        }
                                        
                                        if (catId && categoryBudgets[catId]) {
                                            if (!membersMap[owner].categoriesMap[catId]) {
                                                membersMap[owner].categoriesMap[catId] = {
                                                    ...categoryBudgets[catId], // Copia info da categoria
                                                    memberSpent: 0
                                                };
                                            }
                                            membersMap[owner].categoriesMap[catId].memberSpent += share;
                                        }
                                    }
                                });
                            }
                        }
                    });

                    // Formatar o retorno
                    const memberExpenses = Object.values(membersMap).map(m => {
                        // Atualizar familyTotalSpent em cada categoria do membro para refletir o total final
                        const memberCats = Object.values(m.categoriesMap).map(mc => {
                            mc.familyTotalSpent = categoryBudgets[mc.categoryId].familyTotalSpent;
                            return mc;
                        });
                        
                        // Ordenar categorias pelo maior gasto do membro
                        memberCats.sort((a, b) => b.memberSpent - a.memberSpent);

                        return {
                            memberId: m.memberId,
                            memberName: m.memberName,
                            avatarUrl: m.avatarUrl,
                            monthlyIncome: m.monthlyIncome,
                            totalSpent: m.totalSpent,
                            sharedSpent: m.totalSpent - m.individualSpent,
                            individualSpent: m.individualSpent,
                            categories: memberCats
                        };
                    });

                    // Ordenar membros por quem gastou mais
                    memberExpenses.sort((a, b) => b.totalSpent - a.totalSpent);

                    res.json({
                        totalBalance,
                        familyTotalExpenses,
                        memberExpenses
                    });
                });
            });
        });
    });
};
