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
        accounts.forEach(acc => {
            if (acc.type !== 'CREDIT') {
                totalBalance += acc.current_balance;
            }
        });

        // 2. Buscar todos os membros
        db.all(`SELECT id, name, avatar_url, COALESCE(monthly_income, 0) as total_income FROM members WHERE family_id = ?`, [familyId], (err, members) => {
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

exports.forceUpdateAICache = async (familyId, loggedInMemberId = null) => {
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const monthStr = new Date().toISOString().slice(0, 7);

    try {
        const queryPromise = (query, params) => {
            return new Promise((resolve, reject) => {
                db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
        };

        await queryPromise(`
            CREATE TABLE IF NOT EXISTS family_ai_cache (
                family_id INT PRIMARY KEY,
                cached_response TEXT NOT NULL,
                last_hash VARCHAR(64) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, []);

        // 1. Contas e Saldos
        const accounts = await queryPromise(`SELECT current_balance, type FROM accounts WHERE family_id = ? AND type != 'INVESTMENT'`, [familyId]);
        let totalBalance = 0;
        accounts.forEach(acc => {
            if (acc.type !== 'CREDIT') {
                totalBalance += acc.current_balance;
            }
        });

        // 2. Membros e Renda
        const members = await queryPromise(`SELECT id, name, COALESCE(monthly_income, 0) as total_income FROM members WHERE family_id = ?`, [familyId]);
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

        // 5. Contas (Fixas e Variáveis)
        const activeBills = await queryPromise(`SELECT amount, due_day, name, type FROM recurring_bills WHERE family_id = ? AND is_active = 1`, [familyId]);
        const totalFixedExpenses = activeBills.reduce((sum, item) => sum + (item.amount || 0), 0);

        // 5b. Próximo Recebimento do Membro (usa o admin ou o primeiro se não for passado)
        let memberToQuery = loggedInMemberId;
        if (!memberToQuery && members.length > 0) {
            memberToQuery = members[0].id; // Fallback se chamado do background job sem user logado específico
        }

        let loggedInMemberRow = [];
        if (memberToQuery) {
            loggedInMemberRow = await queryPromise(`
                SELECT name, monthly_income, salary_day, advance_value, advance_day 
                FROM members 
                WHERE id = ?
            `, [memberToQuery]);
        }

        let nextPaymentInfo = null;
        let totalUpcomingBills = 0; 
        let totalRemainingBillsThisMonth = 0; 

        const now = new Date();
        const currentDay = now.getDate();
        const currentMonthNum = now.getMonth() + 1;
        const currentYearNum = now.getFullYear();

        if (loggedInMemberRow && loggedInMemberRow.length > 0) {
            const member = loggedInMemberRow[0];
            const salaryDay = member.salary_day;
            const advanceDay = member.advance_day;

            const candidates = [];
            if (salaryDay && member.monthly_income > 0) {
                candidates.push({ type: 'Salário', day: salaryDay, value: member.monthly_income });
            }
            if (advanceDay && member.advance_value > 0) {
                candidates.push({ type: 'Adiantamento', day: advanceDay, value: member.advance_value });
            }
            candidates.sort((a, b) => a.day - b.day);

            const futureCandidates = candidates.filter(c => c.day >= currentDay);

            let cashflowCycles = [];
            let currentRunningBalance = totalBalance;
            let lastProcessedDay = currentDay;

            // Helper to sum bills in range [startDay, endDay]
            const getBillsInRange = (startDay, endDay) => {
                let sum = 0;
                let list = [];
                activeBills.forEach(bill => {
                    const d = bill.due_day;
                    if (d && d >= startDay && d <= endDay) {
                        sum += (bill.amount || 0);
                        list.push({ name: bill.name, amount: bill.amount || 0, dueDay: d });
                    }
                });
                return { sum, list };
            };

            // Calculate cycles before each future receipt
            for (let i = 0; i < futureCandidates.length; i++) {
                let cand = futureCandidates[i];
                let cycleEndDay = cand.day - 1;

                if (cycleEndDay >= lastProcessedDay) {
                    const bills = getBillsInRange(lastProcessedDay, cycleEndDay);
                    let finalBalance = currentRunningBalance - bills.sum;
                    cashflowCycles.push({
                        name: `Até dia ${cycleEndDay}`,
                        startDay: lastProcessedDay,
                        endDay: cycleEndDay,
                        initialBalance: currentRunningBalance,
                        income: 0,
                        incomeName: '',
                        billsTotal: bills.sum,
                        billsList: bills.list,
                        projectedBalance: finalBalance
                    });
                    currentRunningBalance = finalBalance;
                    lastProcessedDay = cand.day;
                }
                
                // Add the income on the candidate day to the running balance
                // Wait, it's better to just start the next cycle WITH this income
                // We'll let the next iteration (or the EOM block) handle the period starting with this income
            }

            // Final cycle (from lastProcessedDay to EOM)
            const daysInCurrentMonth = new Date(currentYearNum, currentMonthNum, 0).getDate();
            if (lastProcessedDay <= daysInCurrentMonth) {
                // Determine incomes that hit exactly on lastProcessedDay or later
                // Actually, any future candidate that hasn't been consumed as an income in a cycle yet.
                // It's simpler: for this final cycle, the income is the sum of all futureCandidates that hit on lastProcessedDay.
                let cycleIncomes = futureCandidates.filter(c => c.day >= lastProcessedDay);
                let totalIncome = cycleIncomes.reduce((sum, c) => sum + c.value, 0);
                let incomeNames = cycleIncomes.map(c => c.type).join(' + ');

                const bills = getBillsInRange(lastProcessedDay, daysInCurrentMonth);
                let finalBalance = currentRunningBalance + totalIncome - bills.sum;
                
                cashflowCycles.push({
                    name: `Fim do Mês (Dia ${lastProcessedDay}-${daysInCurrentMonth})`,
                    startDay: lastProcessedDay,
                    endDay: daysInCurrentMonth,
                    initialBalance: currentRunningBalance,
                    income: totalIncome,
                    incomeName: incomeNames,
                    billsTotal: bills.sum,
                    billsList: bills.list,
                    projectedBalance: finalBalance
                });
                currentRunningBalance = finalBalance;
            }
            
            // To maintain compatibility with old payload just in case, we can keep totalUpcomingBills 
            // as the bills of the very first cycle.
            if (cashflowCycles.length > 0) {
                totalUpcomingBills = cashflowCycles[0].billsTotal;
            }

            // Calculate totalRemainingBillsThisMonth for strict calculation
            totalRemainingBillsThisMonth = getBillsInRange(currentDay, daysInCurrentMonth).sum;

            nextPaymentInfo = {
                memberName: member.name,
                cycles: cashflowCycles
            };
        }

        let familyTotalExpenses = 0;
        let familyExtraExpenses = 0;
        const categoryMap = {};
        budgets.forEach(b => {
            categoryMap[b.id] = { id: b.id, name: b.name, limit: b.budget_limit || 0, spent: 0 };
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

        const crypto = require('crypto');
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysRemaining = daysInMonth - currentDay + 1;
        const monthProgress = currentDay / daysInMonth;

        const strictProjectedBalance = familyTotalIncome - familyTotalExpenses - totalRemainingBillsThisMonth;
        const strictIsInTheRed = strictProjectedBalance < 0;

        const cacheInput = JSON.stringify({
            totalBalance,
            familyTotalIncome,
            familyTotalExpenses,
            totalFixedExpenses,
            familyExtraExpenses,
            currentDay,
            daysRemaining,
            categoryValues: Object.values(categoryMap),
            recentTransactions: transactions.slice(0, 15).map(t => ({ desc: t.description, val: t.amount, data: t.transaction_date })),
            nextPaymentInfo
        });
        const dataHash = crypto.createHash('sha256').update(cacheInput).digest('hex');

        // Verifica cache e retorna se já existe (para quando é chamado de background e nada mudou de verdade)
        const cached = await queryPromise(`SELECT cached_response, last_hash FROM family_ai_cache WHERE family_id = ?`, [familyId]);
        if (cached && cached.length > 0 && cached[0].last_hash === dataHash) {
            console.log(`⚡ Retornando análise do Termômetro do cache (Background check) para a família ${familyId}`);
            return JSON.parse(cached[0].cached_response);
        }

        // 6. Chamada ao Gemini
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("Chave da IA não configurada no .env");
        }

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });

        const systemInstruction = `
Você é uma IA analista financeira do app "Gestão Mob".
Sua tarefa é analisar o panorama financeiro de uma família e retornar um objeto JSON com diagnósticos e insights personalizados.

Sua resposta deve ser EXCLUSIVAMENTE um objeto JSON válido com as seguintes chaves:
1. "projectedBalance": (Number) ignorado.
2. "safeDailySpend": (Number) O limite de gasto diário recomendado para que a família termine o mês no azul.
3. "isInTheRed": (Boolean) ignorado.
4. "insights": Um array de no máximo 3 objetos, onde cada objeto de insight tem:
   - "title": (String) Título chamativo e curto (ex: "Custo Fixo Saudável", "Orçamento Estourado", "Alimentação Acelerada").
   - "type": (String) "red" para alertas graves, "green" para conquistas/diagnósticos saudáveis, "blue" ou "orange" para alertas médios ou informativos.
   - "description": (String) Descrição explicativa curta e acionável com o nome de quem gastou ou o que causou o padrão. Seja direto.
   - "action": (Objeto OPCIONAL) Use EXCLUSIVAMENTE se houver um alerta vermelho por Fluxo de Caixa negativo OU estouro de ritmo (Pacing) em categorias. Sugira REDUZIR o limite (budget_limit) de alguma outra categoria (ou da própria) para compensar e salvar dinheiro. Formato:
     { "type": "REDUCE_BUDGET", "payload": { "categoryId": ID_AQUI, "amount": VALOR_NUMERICO_A_REDUZIR }, "label": "Reduzir R$ VALOR de NOME_DA_CATEGORIA" }
   
Importante sobre Pacing (Orçamento Fracionado): Analise a porcentagem gasta de cada categoria comparada à porcentagem do mês decorrido ("Progresso do mês"). Se a categoria gastou 80% do limite mas estamos em 30% do mês, alerte sobre o "ritmo acelerado"!
Importante sobre o próximo recebimento: se fornecido no prompt o próximo recebimento do usuário logado e as contas a vencer antes dele, você deve gerar obrigatoriamente um insight/alerta do tipo 'orange' ou 'red' caso o saldo atual não cubra o período.
`;

        let loggedInMemberPrompt = '';
        if (nextPaymentInfo && nextPaymentInfo.cycles) {
            loggedInMemberPrompt = `
Dados de Ciclos de Fluxo de Caixa do Usuário Logado (${nextPaymentInfo.memberName}):
${nextPaymentInfo.cycles.map((c, index) => `
Ciclo ${index + 1} (${c.name}):
- Saldo Inicial Projetado: R$ ${c.initialBalance.toFixed(2)}
- Entradas no Período: R$ ${c.income.toFixed(2)} ${c.incomeName ? '(' + c.incomeName + ')' : ''}
- Total de Contas no Período: R$ ${c.billsTotal.toFixed(2)}
- Saldo Final Projetado: R$ ${c.projectedBalance.toFixed(2)}
- Contas: ${c.billsList.length > 0 ? c.billsList.map(b => `${b.name} (R$ ${b.amount.toFixed(2)})`).join(', ') : 'Nenhuma'}
`).join('\n')}
`;
        }

        const prompt = `
Métricas Atuais:
- Saldo atual disponível nas contas: R$ ${totalBalance.toFixed(2)}
- Renda familiar mensal total: R$ ${familyTotalIncome.toFixed(2)}
- Total já gasto no mês: R$ ${familyTotalExpenses.toFixed(2)}
- Despesas fixas (contas recorrentes): R$ ${totalFixedExpenses.toFixed(2)}
- Despesas extras (fora fixas): R$ ${familyExtraExpenses.toFixed(2)}
- Dia atual do mês: ${currentDay} de ${daysInMonth} dias totais.
- Progresso do mês: ${(monthProgress * 100).toFixed(0)}% decorrido.
- Dias restantes: ${daysRemaining} dias.
${loggedInMemberPrompt}

Gastos por Categoria:
${JSON.stringify(Object.values(categoryMap), null, 2)}

Lista de Transações Recentes para Contexto:
${JSON.stringify(transactions.slice(0, 15).map(t => ({ desc: t.description, val: t.amount, data: t.transaction_date })), null, 2)}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-flash-latest',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: 'application/json'
            }
        });

        const aiResponseText = response.text.trim();
        const aiJson = JSON.parse(aiResponseText);

        const finalResponsePayload = {
            useFallback: false,
            totalBalance,
            familyTotalIncome,
            familyTotalExpenses,
            daysRemaining,
            projectedLeftover: strictProjectedBalance,
            safeDailySpend: aiJson.safeDailySpend,
            isInTheRed: strictIsInTheRed,
            insights: aiJson.insights,
            upcomingFortnightBills: totalUpcomingBills,
            cashflowCycles: nextPaymentInfo ? nextPaymentInfo.cycles : []
        };

        const finalResponseJsonStr = JSON.stringify(finalResponsePayload);

        try {
            if (cached && cached.length > 0) {
                await queryPromise(`UPDATE family_ai_cache SET cached_response = ?, last_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE family_id = ?`, [finalResponseJsonStr, dataHash, familyId]);
            } else {
                await queryPromise(`INSERT INTO family_ai_cache (family_id, cached_response, last_hash) VALUES (?, ?, ?)`, [familyId, finalResponseJsonStr, dataHash]);
            }
            console.log(`💾 Cache da análise atualizado para a família ${familyId}`);
        } catch (cacheWriteErr) {
            console.error('❌ Erro ao salvar cache no banco de dados:', cacheWriteErr);
        }

        return finalResponsePayload;

    } catch (err) {
        console.error('Erro na análise da IA do Termômetro em background:', err);
        throw err;
    }
};

exports.getThermometerAIData = async (req, res) => {
    const familyId = req.user.family_id;

    try {
        const queryPromise = (query, params) => {
            return new Promise((resolve, reject) => {
                db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
        };

        const cached = await queryPromise(`SELECT cached_response FROM family_ai_cache WHERE family_id = ?`, [familyId]);
        
        if (cached && cached.length > 0) {
            // Serve instantaneamente
            const payload = JSON.parse(cached[0].cached_response);
            return res.json(payload);
        }

        // Se estiver vazio (primeira vez ever), forçamos e esperamos
        console.log(`⚠️ Cache vazio para familia ${familyId}, calculando sincronicamente pela primeira vez...`);
        const payload = await exports.forceUpdateAICache(familyId, req.user.id);
        return res.json(payload);

    } catch (err) {
        console.error('Erro ao buscar IA do Termômetro do cache:', err);
        res.status(200).json({
            useFallback: true,
            error: err.message
        });
    }
};

exports.executeAIAction = async (req, res) => {
    const familyId = req.user.family_id;
    const { actionType, payload } = req.body;

    if (!actionType || !payload) {
        return res.status(400).json({ error: 'Missing actionType or payload' });
    }

    try {
        const db = require('../config/database');
        const queryPromise = (query, params) => {
            return new Promise((resolve, reject) => {
                db.run(query, params, function (err) {
                    if (err) reject(err);
                    else resolve(this);
                });
            });
        };

        if (actionType === 'REDUCE_BUDGET') {
            const categoryId = payload.categoryId;
            const amount = parseFloat(payload.amount);

            if (!categoryId || isNaN(amount) || amount <= 0) {
                return res.status(400).json({ error: 'Invalid categoryId or amount' });
            }

            // Garante que o limite não fique negativo
            await queryPromise(`
                UPDATE categories 
                SET budget_limit = GREATEST(0, budget_limit - ?) 
                WHERE id = ? AND family_id = ?
            `, [amount, categoryId, familyId]);

            // Dispara atualização do termômetro
            const { triggerUpdate } = require('../services/financialEventService');
            triggerUpdate(familyId);

            return res.json({ message: 'Orçamento reduzido com sucesso.' });
        } else {
            return res.status(400).json({ error: 'Unsupported actionType' });
        }
    } catch (err) {
        console.error('Erro ao executar ação da IA:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
