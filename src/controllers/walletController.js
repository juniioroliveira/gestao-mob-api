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
        db.all(`SELECT id, name, avatar_url, COALESCE(monthly_income, 0) + COALESCE(advance_value, 0) as total_income FROM members WHERE family_id = ?`, [familyId], (err, members) => {
            if (err) return res.status(500).json({ error: 'Erro interno' });

            let familyTotalIncome = 0;
            const membersMap = {};
            members.forEach(m => {
                familyTotalIncome += m.total_income;
                membersMap[m.id] = {
                    memberId: m.id,
                    memberName: m.name,
                    avatarUrl: m.avatar_url,
                    monthlyIncome: m.total_income,
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
                    SELECT t.amount, t.member_id, t.category_id, t.type, t.recurring_bill_id, a.type as account_type
                    FROM transactions t
                    JOIN accounts a ON t.account_id = a.id
                    WHERE a.family_id = ? AND t.type IN ('EXPENSE', 'TRANSFER') 
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
                `;

                db.all(queryTransactions, [familyId, monthStr], (err, transactions) => {
                    if (err) return res.status(500).json({ error: 'Erro interno' });

                    let familyTotalExpenses = 0;
                    let familyExtraExpenses = 0;

                    transactions.forEach(t => {
                        const amount = t.amount;
                        const catId = t.category_id;
                        
                        // Filtramos apenas as despesas reais para não duplicar com as transferências (pagamentos de fatura de cartão)
                        if (t.type === 'EXPENSE') {
                            familyTotalExpenses += amount;
                            if (!t.recurring_bill_id) {
                                familyExtraExpenses += amount;
                            }

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
                        familyExtraExpenses,
                        familyTotalIncome,
                        memberExpenses
                    });
                });
            });
        });
    });
};

exports.getThermometerAIData = async (req, res) => {
    const familyId = req.user.family_id;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const monthStr = new Date().toISOString().slice(0, 7);

    try {
        // Obter os dados básicos necessários usando Promises
        const queryPromise = (query, params) => {
            return new Promise((resolve, reject) => {
                db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
        };

        // 1. Contas e Saldos
        const accounts = await queryPromise(`SELECT current_balance, type FROM accounts WHERE family_id = ? AND type != 'INVESTMENT'`, [familyId]);
        let totalBalance = 0;
        accounts.forEach(acc => totalBalance += acc.current_balance);

        // 2. Membros e Renda
        const members = await queryPromise(`SELECT id, name, COALESCE(monthly_income, 0) + COALESCE(advance_value, 0) as total_income FROM members WHERE family_id = ?`, [familyId]);
        let familyTotalIncome = 0;
        members.forEach(m => familyTotalIncome += m.total_income);

        // 3. Limites de Orçamentos por Categoria
        const budgets = await queryPromise(`
            SELECT c.id, c.name, c.color_hex, b.budget_limit 
            FROM categories c
            LEFT JOIN category_budgets b ON c.id = b.category_id AND b.month = ? AND b.year = ?
            WHERE c.family_id = ? AND c.type = 'EXPENSE'
        `, [currentMonth, currentYear, familyId]);

        // 4. Transações do Mês
        const transactions = await queryPromise(`
            SELECT t.amount, t.member_id, t.category_id, t.type, t.description, t.transaction_date, t.recurring_bill_id, a.type as account_type
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE a.family_id = ? AND t.type IN ('EXPENSE', 'TRANSFER')
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
        `, [familyId, monthStr]);

        // 5. Contas Fixas
        const fixedExpenses = await queryPromise(`SELECT amount, due_day, name FROM recurring_bills WHERE family_id = ? AND is_active = 1`, [familyId]);
        const totalFixedExpenses = fixedExpenses.fold ? fixedExpenses.reduce((sum, item) => sum + item.amount, 0) : fixedExpenses.reduce((sum, item) => sum + item.amount, 0);

        // Processar transações e categorias
        let familyTotalExpenses = 0;
        let familyExtraExpenses = 0;
        const categoryMap = {};
        budgets.forEach(b => {
            categoryMap[b.id] = { name: b.name, limit: b.budget_limit || 0, spent: 0 };
        });

        transactions.forEach(t => {
            if (t.type === 'EXPENSE') {
                familyTotalExpenses += t.amount;
                if (!t.recurring_bill_id) {
                    familyExtraExpenses += t.amount;
                }
                if (t.category_id && categoryMap[t.category_id]) {
                    categoryMap[t.category_id].spent += t.amount;
                }
            }
        });

        // 6. Fazer a chamada ao Gemini se a chave estiver configurada
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(200).json({
                useFallback: true,
                message: "Chave da IA não configurada no .env"
            });
        }

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });

        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const currentDay = now.getDate();
        const daysRemaining = daysInMonth - currentDay + 1;

        const systemInstruction = `
Você é uma IA analista financeira do app "Gestão Mob".
Sua tarefa é analisar o panorama financeiro de uma família e retornar um objeto JSON com diagnósticos e insights personalizados.

Sua resposta deve ser EXCLUSIVAMENTE um objeto JSON válido com as seguintes chaves:
1. "projectedBalance": (Number) A estimativa do saldo que sobrará (se positivo) ou faltará (se negativo) no final do mês baseado nas tendências de gastos.
2. "safeDailySpend": (Number) O limite de gasto diário recomendado para que a família termine o mês no azul.
3. "isInTheRed": (Boolean) true se a estimativa projetada de saldo restante for negativa, false se for positiva.
4. "insights": Um array de no máximo 3 objetos, onde cada objeto de insight tem:
   - "title": (String) Título chamativo e curto (ex: "Custo Fixo Saudável", "Orçamento Estourado", "Alimentação Acelerada").
   - "type": (String) "red" para alertas graves, "green" para conquistas/diagnósticos saudáveis, "blue" ou "orange" para alertas médios ou informativos.
   - "description": (String) Descrição explicativa curta e acionável com o nome de quem gastou ou o que causou o padrão. Seja direto.
`;

        const prompt = `
Métricas Atuais:
- Saldo atual disponível nas contas: R$ ${totalBalance.toFixed(2)}
- Renda familiar mensal total: R$ ${familyTotalIncome.toFixed(2)}
- Total já gasto no mês: R$ ${familyTotalExpenses.toFixed(2)}
- Despesas fixas (contas recorrentes): R$ ${totalFixedExpenses.toFixed(2)}
- Despesas extras (fora fixas): R$ ${familyExtraExpenses.toFixed(2)}
- Dia atual do mês: ${currentDay} de ${daysInMonth} dias totais.
- Dias restantes: ${daysRemaining} dias.

Gastos por Categoria:
${JSON.stringify(Object.values(categoryMap), null, 2)}

Lista de Transações Recentes para Contexto:
${JSON.stringify(transactions.slice(0, 15).map(t => ({ desc: t.description, val: t.amount, data: t.transaction_date })), null, 2)}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: 'application/json'
            }
        });

        const aiResponseText = response.text.trim();
        const aiJson = JSON.parse(aiResponseText);

        res.json({
            useFallback: false,
            totalBalance,
            familyTotalIncome,
            familyTotalExpenses,
            daysRemaining,
            projectedLeftover: aiJson.projectedBalance,
            safeDailySpend: aiJson.safeDailySpend,
            isInTheRed: aiJson.isInTheRed,
            insights: aiJson.insights
        });

    } catch (err) {
        console.error('Erro na análise da IA do Termômetro:', err);
        res.status(200).json({
            useFallback: true,
            error: err.message
        });
    }
};
