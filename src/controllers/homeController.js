const db = require('../config/database');
const { isMemberOnline } = require('../websockets/socket');

const queryPromise = (query, params) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

exports.getHomeData = async (req, res) => {
    try {
        const familyId = req.user.family_id;
        const currentUserId = req.user.id;

        // 1. Contas e Saldos
        const accounts = await queryPromise(
            `SELECT id, name, current_balance, type, bank_code, color_hex, card_last_digits, is_debit, is_credit, credit_limit FROM accounts WHERE family_id = ?`, 
            [familyId]
        );
        
        let totalBalance = 0;
        let totalInvestments = 0;
        let creditCardDebt = 0; // Armazena a dívida de cartão de crédito para subtrair do saldo livre
        
        accounts.forEach(acc => {
            if (acc.type === 'CREDIT') {
                // Cartão de crédito geralmente tem saldo negativo, mas por segurança somamos o absoluto
                creditCardDebt += Math.abs(acc.current_balance);
            } else if (acc.type === 'INVESTMENT') {
                totalInvestments += acc.current_balance;
            } else {
                totalBalance += acc.current_balance;
            }
        });

        // 2. Receitas e Despesas do Mês Atual
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        
        // Income
        const [incomeData] = await queryPromise(
            `SELECT SUM(t.amount) as total FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             WHERE a.family_id = ? AND t.type = 'INCOME' AND strftime('%Y-%m', t.transaction_date) = ?`,
            [familyId, currentMonth]
        );
        const income = incomeData?.total || 0;

        // Cash Expenses (Débito/Dinheiro/Pix)
        const [cashExpenseData] = await queryPromise(
            `SELECT SUM(t.amount) as total FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             WHERE a.family_id = ? AND t.type = 'EXPENSE' AND a.type != 'CREDIT' AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?`,
            [familyId, currentMonth]
        );
        const cashExpenses = cashExpenseData?.total || 0;

        // Credit Card Bills (Faturas do mês)
        const [creditBillsData] = await queryPromise(
            `SELECT SUM(t.amount) as total FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             WHERE a.family_id = ? AND t.type = 'EXPENSE' AND a.type = 'CREDIT' 
             AND DATE_FORMAT(
                 DATE_ADD(
                     t.transaction_date, 
                     INTERVAL (
                         (CASE WHEN DAY(t.transaction_date) >= COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END) +
                         (CASE WHEN COALESCE(a.due_day, 1) < COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END)
                     ) MONTH
                 ),
                 '%Y-%m'
             ) = ?`,
            [familyId, currentMonth]
        );
        const creditCardBills = creditBillsData?.total || 0;

        let userCreditCardBillsShare = 0;

        // Total Expense do mês = cashExpenses + creditCardBills
        const expense = cashExpenses + creditCardBills;


        // 2.5 Despesas por Categoria para o Gráfico de Barras em Camadas
        const categoryExpensesRaw = await queryPromise(
            `SELECT c.id, c.name, c.color_hex, SUM(t.amount) as total
             FROM transactions t
             JOIN categories c ON t.category_id = c.id
             JOIN accounts a ON t.account_id = a.id
             WHERE a.family_id = ? AND t.type = 'EXPENSE' 
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
             GROUP BY c.id
             ORDER BY total DESC`,
            [familyId, currentMonth]
        );

        const categoryExpenses = categoryExpensesRaw.map(c => ({
            ...c,
            color_hex: c.color_hex || '#CCCCCC'
        }));

        // 3. Membros da Família
        const membersRaw = await queryPromise(
            `SELECT id, family_id, name, avatar_url, role, is_admin, monthly_income, salary_day, advance_value, advance_day FROM members WHERE family_id = ?`,
            [familyId]
        );

        const members = membersRaw.map(member => ({
            ...member,
            is_online: isMemberOnline(member.id)
        }));

        // 4. Últimas Transações
        const rawRecentTransactions = await queryPromise(
            `SELECT t.id, t.amount, t.type, t.description, t.transaction_date, 
                    t.account_id, t.destination_account_id, t.category_id, t.member_id, t.payment_type, t.recurring_bill_id,
                    a.name as account_name, 
                    c.name as category_name, c.icon, c.color_hex 
             FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             LEFT JOIN categories c ON t.category_id = c.id 
             WHERE a.family_id = ? 
             ORDER BY t.transaction_date DESC, t.id DESC LIMIT 4`,
            [familyId]
        );

        // Mapear os membros para as transações (suportando array de IDs)
        const recentTransactions = rawRecentTransactions.map(t => {
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
                // Caso seja INT simples (legado)
                const m = members.find(mem => mem.id === t.member_id);
                memberName = m ? m.name : 'Desconhecido';
            }
            return {
                ...t,
                member_name: memberName
            };
        });

        // 5. Dados do Usuário Atual (incluindo dados de salário/adiantamento)
        const [currentUser] = await queryPromise(
            `SELECT id, name, avatar_url, is_admin, salary_day, advance_day, advance_value, monthly_income FROM members WHERE id = ?`,
            [req.user.id]
        );

        // 6. Dados da Família
        const [familyInfo] = await queryPromise(
            `SELECT name FROM families WHERE id = ?`,
            [familyId]
        );

        const salaryDay = currentUser.salary_day || 5;
        const advanceDay = currentUser.advance_day || 20;

        // Função auxiliar para identificar o período do vencimento da conta
        function getPeriodForDueDay(dueDay) {
            if (salaryDay < advanceDay) {
                if (dueDay >= salaryDay && dueDay < advanceDay) {
                    return 'SALARY';
                } else {
                    return 'ADVANCE';
                }
            } else {
                if (dueDay >= advanceDay && dueDay < salaryDay) {
                    return 'ADVANCE';
                } else {
                    return 'SALARY';
                }
            }
        }

        // 7. Total de Contas Fixas Recorrentes (Ativas) com cálculo de rateio personalizado para o usuário atual
        const recurringBills = await queryPromise(
            `SELECT amount, member_id, due_day FROM recurring_bills WHERE family_id = ? AND is_active = 1`,
            [familyId]
        );

        let fixedExpensesTotal = 0;
        let salaryPeriodFixedTotal = 0;
        let advancePeriodFixedTotal = 0;

        for (const bill of recurringBills) {
            try {
                let billShare = 0;
                if (bill.member_id) {
                    let memIds;
                    if (typeof bill.member_id === 'string' && bill.member_id.startsWith('[')) {
                        memIds = JSON.parse(bill.member_id);
                    } else if (Array.isArray(bill.member_id)) {
                        memIds = bill.member_id;
                    } else {
                        memIds = [parseInt(bill.member_id, 10)];
                    }

                    if (Array.isArray(memIds)) {
                        if (memIds.includes(currentUserId)) {
                            billShare = bill.amount / memIds.length;
                        }
                    }
                } else {
                    // Sem membro definido: divide igualmente entre todos os membros da família
                    const [membersCountRow] = await queryPromise(
                        `SELECT COUNT(*) as count FROM members WHERE family_id = ?`,
                        [familyId]
                    );
                    const count = membersCountRow.count || 1;
                    billShare = bill.amount / count;
                }

                fixedExpensesTotal += billShare;
                
                // Distribui no período correto
                const period = getPeriodForDueDay(bill.due_day || 15);
                if (period === 'SALARY') {
                    salaryPeriodFixedTotal += billShare;
                } else {
                    advancePeriodFixedTotal += billShare;
                }
            } catch (e) {
                // Fallback
                if (parseInt(bill.member_id, 10) === currentUserId) {
                    fixedExpensesTotal += bill.amount;
                    const period = getPeriodForDueDay(bill.due_day || 15);
                    if (period === 'SALARY') {
                        salaryPeriodFixedTotal += bill.amount;
                    } else {
                        advancePeriodFixedTotal += bill.amount;
                    }
                }
            }
        }

        // Calcula divisão de períodos para despesas do cartão de crédito
        let salaryPeriodCreditTotal = 0;
        let advancePeriodCreditTotal = 0;

        // Faturas do mês do cartão de crédito mapeadas por período
        const creditTransactions = await queryPromise(
            `SELECT t.amount, t.member_id, a.due_day as card_due_day FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             WHERE a.family_id = ? AND t.type = 'EXPENSE' AND a.type = 'CREDIT' 
             AND DATE_FORMAT(
                 DATE_ADD(
                     t.transaction_date, 
                     INTERVAL (
                         (CASE WHEN DAY(t.transaction_date) >= COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END) +
                         (CASE WHEN COALESCE(a.due_day, 1) < COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END)
                     ) MONTH
                 ),
                 '%Y-%m'
             ) = ?`,
            [familyId, currentMonth]
        );

        userCreditCardBillsShare = 0;
        for (const t of creditTransactions) {
            try {
                let txShare = 0;
                if (t.member_id) {
                    let memIds;
                    if (typeof t.member_id === 'string' && t.member_id.startsWith('[')) {
                        memIds = JSON.parse(t.member_id);
                    } else if (Array.isArray(t.member_id)) {
                        memIds = t.member_id;
                    } else {
                        memIds = [parseInt(t.member_id, 10)];
                    }

                    if (Array.isArray(memIds) && memIds.includes(currentUserId)) {
                        txShare = t.amount / memIds.length;
                    }
                } else {
                    const [membersCountRow] = await queryPromise(
                        `SELECT COUNT(*) as count FROM members WHERE family_id = ?`,
                        [familyId]
                    );
                    const count = membersCountRow.count || 1;
                    txShare = t.amount / count;
                }

                userCreditCardBillsShare += txShare;

                // Distribui no período correto baseado no vencimento da fatura do cartão
                const period = getPeriodForDueDay(t.card_due_day || 10);
                if (period === 'SALARY') {
                    salaryPeriodCreditTotal += txShare;
                } else {
                    advancePeriodCreditTotal += txShare;
                }
            } catch (e) {
                if (parseInt(t.member_id, 10) === currentUserId) {
                    userCreditCardBillsShare += t.amount;
                    const period = getPeriodForDueDay(t.card_due_day || 10);
                    if (period === 'SALARY') {
                        salaryPeriodCreditTotal += t.amount;
                    } else {
                        advancePeriodCreditTotal += t.amount;
                    }
                }
            }
        }

        res.status(200).json({
            user: currentUser,
            familyName: familyInfo ? familyInfo.name : 'Minha Família',
            totalBalance,
            totalInvestments,
            creditCardDebt,
            accounts,
            income,
            expense,
            cashExpenses,
            creditCardBills,
            fixedExpensesTotal: fixedExpensesTotal + userCreditCardBillsShare,
            salaryPeriodTotal: salaryPeriodFixedTotal + salaryPeriodCreditTotal,
            advancePeriodTotal: advancePeriodFixedTotal + advancePeriodCreditTotal,
            categoryExpenses,
            members,
            recentTransactions
        });

    } catch (error) {
        console.error('Erro no getHomeData:', error);
        res.status(500).json({ error: 'Erro ao carregar dados da Home.' });
    }
};