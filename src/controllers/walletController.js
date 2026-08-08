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
                let salDate = new Date(currentYearNum, currentMonthNum - 1, salaryDay);
                if (salaryDay <= currentDay) {
                    salDate = new Date(currentYearNum, currentMonthNum, salaryDay);
                }
                candidates.push({ type: 'Salário', day: salaryDay, value: member.monthly_income, date: salDate });
            }

            if (advanceDay && member.advance_value > 0) {
                let advDate = new Date(currentYearNum, currentMonthNum - 1, advanceDay);
                if (advanceDay <= currentDay) {
                    advDate = new Date(currentYearNum, currentMonthNum, advanceDay);
                }
                candidates.push({ type: 'Adiantamento', day: advanceDay, value: member.advance_value, date: advDate });
            }

            candidates.sort((a, b) => a.date - b.date);
            let nextRec = candidates.length > 0 ? candidates[0] : null;

            if (nextRec) {
                const nextRecDate = nextRec.date;
                const billsInInterval = [];

                activeBills.forEach(bill => {
                    const dueDay = bill.due_day;
                    if (dueDay) {
                        let billDate = new Date(currentYearNum, currentMonthNum - 1, dueDay);
                        if (dueDay < currentDay) {
                            billDate = new Date(currentYearNum, currentMonthNum, dueDay);
                        }
                        
                        const limitDate = new Date(nextRecDate);
                        limitDate.setDate(limitDate.getDate() - 1);

                        if (billDate >= new Date(currentYearNum, currentMonthNum - 1, currentDay) && billDate <= limitDate) {
                            billsInInterval.push({
                                name: bill.name,
                                amount: bill.amount || 0,
                                dueDay: dueDay
                            });
                            totalUpcomingBills += (bill.amount || 0);
                        }
                        
                        const endOfMonth = new Date(currentYearNum, currentMonthNum, 0);
                        if (billDate >= new Date(currentYearNum, currentMonthNum - 1, currentDay) && billDate <= endOfMonth) {
                            totalRemainingBillsThisMonth += (bill.amount || 0);
                        }
                    }
                });

                nextPaymentInfo = {
                    memberName: member.name,
                    nextReceiptType: nextRec.type,
                    nextReceiptDay: nextRec.day,
                    nextReceiptValue: nextRec.value,
                    nextReceiptDate: nextRec.date.toISOString(),
                    upcomingBills: billsInInterval,
                    totalUpcomingBills
                };
            }
        }

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

        const crypto = require('crypto');
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysRemaining = daysInMonth - currentDay + 1;

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
   
Importante sobre o próximo recebimento: se fornecido no prompt o próximo recebimento do usuário logado e as contas a vencer antes dele, você deve gerar obrigatoriamente um insight/alerta do tipo 'orange' ou 'blue' indicando o total que vencerá antes do pagamento e se o saldo atual é suficiente para cobrir.
`;

        let loggedInMemberPrompt = '';
        if (nextPaymentInfo) {
            loggedInMemberPrompt = `
Dados de Recebimento do Usuário Logado (${nextPaymentInfo.memberName}):
- Próximo recebimento previsto: ${nextPaymentInfo.nextReceiptType} no dia ${nextPaymentInfo.nextReceiptDay} (Valor: R$ ${nextPaymentInfo.nextReceiptValue.toFixed(2)})
- Contas fixas da família que vencem até esta data de recebimento:
${nextPaymentInfo.upcomingBills.length > 0 
    ? nextPaymentInfo.upcomingBills.map(b => `  * ${b.name} (Vence dia ${b.dueDay}): R$ ${b.amount.toFixed(2)}`).join('\n')
    : '  * Nenhuma conta fixa vencendo até lá.'}
- Valor total das contas fixas que vencem antes do recebimento: R$ ${nextPaymentInfo.totalUpcomingBills.toFixed(2)}
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
            nextPaymentDate: nextPaymentInfo ? nextPaymentInfo.nextReceiptDate : null,
            nextPaymentValue: nextPaymentInfo ? nextPaymentInfo.nextReceiptValue : null
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
