const db = require('../config/database');
// computeExpensesForMonth é importado dentro de forceUpdateAICache (não aqui no
// topo) de propósito: fixedExpensesController -> financialEventService ->
// walletController fecha um ciclo de require. Requerer em cima travava
// forceUpdateAICache como undefined dentro de financialEventService dependendo
// da ordem em que os módulos fossem carregados pela primeira vez — mesmo padrão
// de require tardio já usado nos outros controllers deste projeto pra evitar isso.
const { getPeriodForDueDay: getPeriodForDueDaySalaryRule } = require('../utils/salaryPeriodHelper');

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
                    extraSpent: 0,
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
                                        if (!t.recurring_bill_id) {
                                            membersMap[owner].extraSpent += share;
                                        }
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
                            extraSpent: m.extraSpent,
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

        // Cache por membro, não mais por família só — cada um tem seus próprios dias
        // de salário/adiantamento e contas, então a resposta da IA é diferente pra
        // cada um (ver migrations/make_ai_cache_per_member.js).
        await queryPromise(`
            CREATE TABLE IF NOT EXISTS family_ai_cache (
                family_id INT NOT NULL,
                member_id INT NOT NULL,
                cached_response TEXT NOT NULL,
                last_hash VARCHAR(64) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (family_id, member_id)
            )
        `, []);

        // 1. Membros e Renda (inclui os dias de salário/adiantamento — precisamos deles
        // já aqui pra saber de quem é o saldo escopado abaixo).
        const members = await queryPromise(`SELECT id, name, COALESCE(monthly_income, 0) as total_income, salary_day, advance_day, COALESCE(advance_value, 0) as advance_value FROM members WHERE family_id = ?`, [familyId]);
        const familyMemberCount = members.length || 1;
        let familyTotalIncome = 0;
        members.forEach(m => familyTotalIncome += m.total_income);

        // Membro de referência pro cálculo de "vai fechar no vermelho": o logado, ou
        // o primeiro da família quando isso roda de um job em background sem sessão.
        let memberToQuery = loggedInMemberId;
        if (!memberToQuery && members.length > 0) {
            memberToQuery = members[0].id;
        }
        const referenceMember = members.find(m => m.id === memberToQuery) || null;

        // 2. Contas e Saldos — totalBalance é da família inteira (só contexto geral pra
        // IA); memberBalance é escopado por dono (conta pessoal só conta pro dono dela,
        // conta "Casa" divide igualmente pela família) — é ESSE que entra no cálculo de
        // vermelho/verde, mesmo critério já usado no badge da Home.
        const accounts = await queryPromise(`SELECT current_balance, type, member_id FROM accounts WHERE family_id = ? AND type != 'INVESTMENT'`, [familyId]);
        let totalBalance = 0;
        let memberBalance = 0;
        accounts.forEach(acc => {
            if (acc.type === 'CREDIT') return;
            totalBalance += acc.current_balance;
            if (acc.member_id) {
                if (acc.member_id === memberToQuery) memberBalance += acc.current_balance;
            } else {
                memberBalance += acc.current_balance / familyMemberCount;
            }
        });

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

        // 5. Contas a pagar do membro de referência — reaproveita o MESMO cálculo da
        // tela Contas a Pagar / badge da Home (atrasados, parcelas, status por
        // transação real), em vez de somar direto recurring_bills.amount (que nem
        // sabia se a conta já tinha sido paga esse mês). AQUI, diferente do badge da
        // Home, a fatura de cartão ENTRA na conta — o Termômetro precisa saber de
        // toda saída de dinheiro real pra dizer se vai fechar no vermelho ou não,
        // não só das contas fixas "tradicionais".
        const now = new Date();
        const currentDay = now.getDate();
        const { computeExpensesForMonth } = require('./fixedExpensesController');
        const pendingBillsForMember = memberToQuery
            ? (await computeExpensesForMonth(familyId, currentMonth, currentYear, null, memberToQuery))
                .filter(e => e.status !== 'Pago')
            : [];
        const totalFixedExpenses = pendingBillsForMember.reduce((sum, item) => sum + (item.amount || 0), 0);

        // 6. Ciclo salário/adiantamento — regra confirmada com o usuário: cada
        // pagamento cobre do seu próprio dia até o dia anterior ao OUTRO pagamento
        // (getPeriodForDueDay, compartilhada com a Home). Conta atrasada (isOverdue)
        // conta como pertencendo ao período ATUAL — é dinheiro devido agora, não numa
        // data futura de calendário.
        let nextPaymentInfo = null;
        let totalUpcomingBills = 0;
        let totalRemainingBillsThisMonth = 0;
        // Fallback pra quando o membro não tem os dois dias configurados: sem dá pra
        // separar por período, então é só saldo do membro menos tudo que resta no mês.
        let strictProjectedBalance = memberBalance - totalFixedExpenses;
        let strictIsInTheRed = strictProjectedBalance < 0;

        if (referenceMember && referenceMember.salary_day && referenceMember.advance_day) {
            const salaryDay = referenceMember.salary_day;
            const advanceDay = referenceMember.advance_day;
            const salaryValue = referenceMember.total_income;
            const advanceValue = referenceMember.advance_value;

            const currentPeriodType = getPeriodForDueDaySalaryRule(currentDay, salaryDay, advanceDay);
            const billPeriod = (bill) => bill.isOverdue
                ? currentPeriodType
                : getPeriodForDueDaySalaryRule(bill.dueDay, salaryDay, advanceDay);

            const currentPeriodBills = pendingBillsForMember.filter(b => billPeriod(b) === currentPeriodType);
            const otherPeriodBills = pendingBillsForMember.filter(b => billPeriod(b) !== currentPeriodType);
            const currentPeriodBillsTotal = currentPeriodBills.reduce((s, b) => s + (b.amount || 0), 0);
            const otherPeriodBillsTotal = otherPeriodBills.reduce((s, b) => s + (b.amount || 0), 0);

            // Dia/valor/nome do próximo pagamento — é ele que fecha o período atual.
            // O "adiantamento" é uma PARTE do salário paga antecipada, não uma renda
            // extra — então quando o próximo pagamento é o salário, o valor que cai de
            // fato é o total menos o que já foi adiantado nesse ciclo. Sem isso, o
            // adiantamento entrava contado duas vezes: uma embutido no saldo atual
            // (assumindo que já foi lançado) e de novo como se fosse dinheiro novo.
            const nextPayDay = currentPeriodType === 'SALARY' ? advanceDay : salaryDay;
            const nextPayValue = currentPeriodType === 'SALARY' ? advanceValue : (salaryValue - advanceValue);
            const nextPayName = currentPeriodType === 'SALARY' ? 'Adiantamento' : 'Salário';

            const currentPeriodProjectedBalance = memberBalance - currentPeriodBillsTotal;
            const nextPeriodProjectedBalance = currentPeriodProjectedBalance + nextPayValue - otherPeriodBillsTotal;

            // ESSE é o número que decide "vai fechar no vermelho": cobre só até o
            // próximo pagamento, com o saldo e as contas de quem está vendo.
            strictProjectedBalance = currentPeriodProjectedBalance;
            strictIsInTheRed = strictProjectedBalance < 0;

            totalUpcomingBills = currentPeriodBillsTotal;
            totalRemainingBillsThisMonth = currentPeriodBillsTotal;

            const toBillsList = (bills) => bills.map(b => ({ name: b.title, amount: b.amount || 0, dueDay: b.dueDay }));

            nextPaymentInfo = {
                memberName: referenceMember.name,
                cycles: [
                    {
                        name: `Até o ${nextPayName.toLowerCase()} (dia ${nextPayDay})`,
                        startDay: currentDay,
                        endDay: nextPayDay - 1,
                        initialBalance: memberBalance,
                        income: 0,
                        incomeName: '',
                        billsTotal: currentPeriodBillsTotal,
                        billsList: toBillsList(currentPeriodBills),
                        projectedBalance: currentPeriodProjectedBalance
                    },
                    {
                        name: `Depois do ${nextPayName.toLowerCase()}`,
                        startDay: nextPayDay,
                        endDay: null,
                        initialBalance: currentPeriodProjectedBalance,
                        income: nextPayValue,
                        incomeName: nextPayName,
                        billsTotal: otherPeriodBillsTotal,
                        billsList: toBillsList(otherPeriodBills),
                        projectedBalance: nextPeriodProjectedBalance
                    }
                ]
            };
        } else if (referenceMember) {
            // Só um dos dois dias configurado (ou nenhum) — sem separação por período.
            totalUpcomingBills = totalFixedExpenses;
            totalRemainingBillsThisMonth = totalFixedExpenses;
            nextPaymentInfo = {
                memberName: referenceMember.name,
                cycles: []
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

        // strictProjectedBalance / strictIsInTheRed já foram calculados acima, por
        // período salário/adiantamento do membro de referência (passo 6).

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
        const cached = await queryPromise(`SELECT cached_response, last_hash FROM family_ai_cache WHERE family_id = ? AND member_id = ?`, [familyId, memberToQuery]);
        if (cached && cached.length > 0 && cached[0].last_hash === dataHash) {
            console.log(`⚡ Retornando análise do Termômetro do cache (Background check) para a família ${familyId}, membro ${memberToQuery}`);
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

        let retries = 3;
        let delay = 3000;
        let aiJson = null;

        while (retries > 0) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-flash-latest',
                    contents: prompt,
                    config: {
                        systemInstruction: systemInstruction,
                        responseMimeType: 'application/json'
                    }
                });

                const aiResponseText = response.text.trim();
                aiJson = JSON.parse(aiResponseText);
                break; // Sucesso, sai do loop
            } catch (error) {
                console.error(`Erro na IA do Termômetro (Tentativas: ${retries - 1}):`, error.message);
                retries--;
                if (retries === 0) {
                    throw new Error("Falha ao gerar IA do termômetro após várias tentativas: " + error.message);
                }
                await new Promise(res => setTimeout(res, delay));
                delay += 2000;
            }
        }

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
                await queryPromise(`UPDATE family_ai_cache SET cached_response = ?, last_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE family_id = ? AND member_id = ?`, [finalResponseJsonStr, dataHash, familyId, memberToQuery]);
            } else {
                await queryPromise(`INSERT INTO family_ai_cache (family_id, member_id, cached_response, last_hash) VALUES (?, ?, ?, ?)`, [familyId, memberToQuery, finalResponseJsonStr, dataHash]);
            }
            console.log(`💾 Cache da análise atualizada para a família ${familyId}, membro ${memberToQuery}`);
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

        const cached = await queryPromise(`SELECT cached_response FROM family_ai_cache WHERE family_id = ? AND member_id = ?`, [familyId, req.user.id]);

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
