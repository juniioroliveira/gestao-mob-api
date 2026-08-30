const db = require('../config/database');
const { getOrCreateWalletAccountId } = require('../utils/walletHelper');
const { triggerUpdate } = require('../services/financialEventService');

// Promisified db.run — dá acesso a `lastID`/`changes` (como o callback do sqlite3)
// sem precisar de callback aninhado. Usado pelas rotas de criar/editar conta e parcelas.
const runPromise = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this); // this.lastID / this.changes
    });
});

const allPromise = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// Núcleo do cálculo de contas a pagar de um mês — extraído de getFixedExpenses pra
// poder ser reaproveitado por outras telas (ex: o badge da Home) sem duplicar a
// lógica de atrasados/parcelas/status. Lança em erro em vez de responder HTTP —
// quem chama decide o que fazer.
// Extrai os ids de membro de recurring_bills.member_id, que vem como um int solto,
// uma string de int, ou um array JSON tipo "[1,2]" (conta com rateio entre vários).
function parseMemberIds(memberIdRaw) {
    if (!memberIdRaw) return [];
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

async function computeExpensesForMonth(familyId, month, year, filterType, currentUserId) {
    // Convert filter month/year to a comparable date format (last day of the month) for start/end date checks
    const targetMonthEndStr = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    const targetMonthStartStr = `${year}-${String(month).padStart(2, '0')}-01`;

    let query = `
        SELECT rb.id, rb.name, rb.amount, rb.due_day, rb.is_active, rb.category_id, rb.member_id, rb.account_id, rb.payment_type,
               rb.type, rb.total_installments, rb.current_installment, rb.start_date, rb.end_date, rb.created_at,
               c.name as category_name, c.color_hex as category_color,
               (SELECT COUNT(*) FROM transactions t
                WHERE t.recurring_bill_id = rb.id
                AND MONTH(t.transaction_date) = ?
                AND YEAR(t.transaction_date) = ?
               ) as is_paid_this_month,
               (SELECT SUM(t.amount) FROM transactions t
                WHERE t.recurring_bill_id = rb.id
                AND MONTH(t.transaction_date) = ?
                AND YEAR(t.transaction_date) = ?
               ) as paid_amount_this_month
        FROM recurring_bills rb
        JOIN categories c ON rb.category_id = c.id
        WHERE rb.family_id = ?
    `;
    const params = [month, year, month, year, familyId];

    if (filterType) {
        query += ` AND rb.type = ?`;
        params.push(filterType);
    }

    // Filter variables by date: we fetch everything that started BEFORE or AT the target month.
    // If it's a variable expense, it must not have ended before the target month (unless we want to show it as unpaid after it ended? Usually it ends when total installments are reached).
    // Actually, to find unpaid past installments, we need to fetch all active bills that existed in the past.
    // We will fetch bills that start before the END of the target month.
    query += ` AND (
        rb.start_date IS NULL OR rb.start_date <= ?
    )`;
    params.push(targetMonthEndStr);
    
    query += ` ORDER BY rb.due_day ASC`;

    const queryPromise = (q, p) => new Promise((resolve, reject) => {
        db.all(q, p, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        let rows = await queryPromise(query, params);

        // Por usuário: conta sem member_id é da casa (rateada, aparece pra todo mundo);
        // conta com member_id só aparece pra quem está na lista — se o usuário logado
        // não está entre os donos, essa conta é de outra pessoa e não deve aparecer aqui.
        if (currentUserId != null) {
            rows = rows.filter(row => {
                const memIds = parseMemberIds(row.member_id);
                return memIds.length === 0 || memIds.includes(currentUserId);
            });
        }

        // Fetch all transactions for this family's recurring bills to check for historical payments
        // Group them by recurring_bill_id and YYYY-MM
        const txQuery = `
            SELECT t.recurring_bill_id, DATE_FORMAT(t.transaction_date, '%Y-%m') as tx_month 
            FROM transactions t
            INNER JOIN recurring_bills rb ON rb.id = t.recurring_bill_id
            WHERE rb.family_id = ? AND t.recurring_bill_id IS NOT NULL
        `;
        const txRows = await queryPromise(txQuery, [familyId]);
        const paidMap = {};
        if (txRows) {
            txRows.forEach(tx => {
                if (!paidMap[tx.recurring_bill_id]) paidMap[tx.recurring_bill_id] = new Set();
                paidMap[tx.recurring_bill_id].add(tx.tx_month);
            });
        }

        // Also include manual payments (retroactive mark-as-paid)
        const manualPaymentsRows = await queryPromise(
            `SELECT recurring_bill_id, reference_month FROM bill_manual_payments WHERE family_id = ?`,
            [familyId]
        );
        if (manualPaymentsRows) {
            manualPaymentsRows.forEach(mp => {
                if (!paidMap[mp.recurring_bill_id]) paidMap[mp.recurring_bill_id] = new Set();
                paidMap[mp.recurring_bill_id].add(mp.reference_month);
            });
        }

        const membersRows = await queryPromise(`SELECT id, name, avatar_url FROM members WHERE family_id = ?`, [familyId]);
        const members = membersRows || [];

        // Parcelas explícitas (data + valor próprios de cada uma) das contas Variáveis
        // cadastradas com o novo modelo de "lista de parcelas". Contas Variáveis antigas
        // não têm linha nenhuma aqui e continuam usando a geração mensal por due_day/start_date.
        const allInstallments = await queryPromise(
            `SELECT ri.id, ri.recurring_bill_id, ri.installment_number, ri.amount, ri.due_date, ri.status, ri.transaction_id
             FROM recurring_bill_installments ri
             INNER JOIN recurring_bills rb ON rb.id = ri.recurring_bill_id
             WHERE rb.family_id = ?
             ORDER BY ri.due_date ASC`,
            [familyId]
        );
        const installmentsByBillId = {};
        (allInstallments || []).forEach(inst => {
            if (!installmentsByBillId[inst.recurring_bill_id]) installmentsByBillId[inst.recurring_bill_id] = [];
            installmentsByBillId[inst.recurring_bill_id].push(inst);
        });

        // Data real de hoje — usada abaixo pra decidir o que é "atrasado de verdade",
        // independente do mês que o usuário está navegando na tela.
        const realToday = new Date();
        realToday.setHours(0, 0, 0, 0);
        const realCurrentYear = realToday.getFullYear();
        const realCurrentMonth = realToday.getMonth() + 1;

        const expenses = [];

        for (const row of rows) {
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

            const getBaseExpenseObj = () => ({
                id: row.id,
                title: row.name,
                amount: row.amount || 0.00,
                rawAmount: row.amount,
                dueDate: `Dia ${row.due_day}`,
                dueDay: row.due_day,
                isActive: Boolean(row.is_active),
                categoryId: row.category_id,
                categoryName: row.category_name,
                categoryColor: row.category_color,
                memberId: row.member_id,
                accountId: row.account_id,
                paymentType: row.payment_type,
                ownerName: ownerName,
                ownerAvatars: ownerAvatars,
                type: row.type || 'FIXED',
                totalInstallments: row.total_installments,
                startDate: row.start_date,
                endDate: row.end_date,
            });

            const billInstallments = installmentsByBillId[row.id];
            const hasExplicitInstallments = row.type === 'VARIABLE' && billInstallments && billInstallments.length > 0;

            if (hasExplicitInstallments) {
                // Modelo novo: cada parcela já tem sua própria data e valor — não tem
                // "due_day mensal" pra assumir, então nada de loop mês a mês aqui. Isso é
                // o que permite cadências irregulares (ex: a cada 15 dias).
                const totalCount = billInstallments.length;
                for (const inst of billInstallments) {
                    const instDate = new Date(inst.due_date);
                    instDate.setHours(0, 0, 0, 0);
                    const instYear = instDate.getFullYear();
                    const instMonth = instDate.getMonth() + 1;

                    // Só mostra parcelas até (e incluindo) o mês que o usuário está navegando —
                    // parcela de daqui a vários meses só aparece quando ele chegar lá.
                    const isAtOrBeforeTarget = (instYear < year) || (instYear === year && instMonth <= month);
                    if (!isAtOrBeforeTarget) continue;

                    const exp = {
                        id: `${row.id}_inst${inst.id}`,
                        installmentId: inst.id,
                        title: row.name,
                        amount: inst.amount,
                        rawAmount: inst.amount,
                        dueDate: `${String(instDate.getDate()).padStart(2, '0')}/${String(instMonth).padStart(2, '0')}`,
                        dueDay: instDate.getDate(),
                        // Só o modelo antigo (abaixo) preenchia isso — sem ele aqui, quem
                        // filtra por competência exata (ex: visão mensal por quinzena)
                        // descartava toda conta com parcela explícita por engano.
                        referenceMonth: `${instYear}-${String(instMonth).padStart(2, '0')}`,
                        isActive: Boolean(row.is_active),
                        categoryId: row.category_id,
                        categoryName: row.category_name,
                        categoryColor: row.category_color,
                        memberId: row.member_id,
                        accountId: row.account_id,
                        paymentType: row.payment_type,
                        ownerName: ownerName,
                        ownerAvatars: ownerAvatars,
                        type: 'VARIABLE',
                        totalInstallments: totalCount,
                        currentInstallment: inst.installment_number,
                        installmentLabel: `Parcela ${inst.installment_number}/${totalCount}`,
                    };

                    const isPaid = inst.status === 'PAID' || inst.transaction_id != null;
                    if (isPaid) {
                        exp.status = 'Pago';
                        exp.statusColor = '#4CAF50';
                        exp.isOverdue = false;
                    } else if (instDate < realToday) {
                        exp.status = 'Atrasado';
                        exp.statusColor = '#F44336';
                        exp.isOverdue = true;
                    } else {
                        const diffDays = Math.ceil((instDate.getTime() - realToday.getTime()) / (1000 * 60 * 60 * 24));
                        if (diffDays <= 5) {
                            exp.status = 'Vence em breve';
                            exp.statusColor = '#FF9800';
                        } else {
                            exp.status = 'Pendente';
                            exp.statusColor = '#2196F3';
                        }
                        exp.isOverdue = false;
                    }

                    expenses.push(exp);
                }

                continue; // já geramos tudo pra essa conta, pula pro próximo `row`
            }

            // 1. GENERATE HISTORICAL UNPAID BILLS
            // Determine the starting point: start_date if available, else created_at
            let startYear, startMonth;
            if (row.start_date) {
                const sDate = new Date(row.start_date);
                startYear = sDate.getFullYear();
                startMonth = sDate.getMonth() + 1;
            } else if (row.created_at) {
                const cDate = new Date(row.created_at);
                startYear = cDate.getFullYear();
                startMonth = cDate.getMonth() + 1;
            } else {
                startYear = year;
                startMonth = month;
            }

            // Loop from start date up to (month - 1) of the selected year
            let currY = startYear;
            let currM = startMonth;
            
            while (currY < year || (currY === year && currM < month)) {
                // If it's a variable expense, stop if we exceed total installments or end_date
                if (row.type === 'VARIABLE' && row.start_date && row.total_installments) {
                    const diffM = (currY - startYear) * 12 + (currM - startMonth);
                    if (diffM >= row.total_installments) {
                        break; // Exceeded installments
                    }
                }

                // "Atrasado" é decidido pela data REAL de hoje, nunca pelo mês que o
                // usuário está navegando — senão, ao navegar pra um mês futuro, o mês
                // atual (ainda em aberto, nem vencido) aparecia incorretamente como atrasado.
                const isBeforeRealCurrentMonth = (currY < realCurrentYear) || (currY === realCurrentYear && currM < realCurrentMonth);
                const isRealCurrentMonth = (currY === realCurrentYear && currM === realCurrentMonth);
                let isGenuinelyOverdue = isBeforeRealCurrentMonth;
                if (!isGenuinelyOverdue && isRealCurrentMonth) {
                    const dueFullDateCheck = new Date(currY, currM - 1, row.due_day);
                    isGenuinelyOverdue = dueFullDateCheck < realToday;
                }
                // Se currY/currM ainda está no futuro (entre hoje e o mês navegado), a conta
                // ainda nem venceu — não gera linha nenhuma aqui, ela aparece na seção 2
                // quando o usuário efetivamente navegar até aquele mês.

                if (isGenuinelyOverdue) {
                    const monthStr = `${currY}-${String(currM).padStart(2, '0')}`;

                    // If this historical month was not paid, generate an overdue instance
                    if (!paidMap[row.id] || !paidMap[row.id].has(monthStr)) {
                        const exp = getBaseExpenseObj();
                        exp.status = 'Atrasado';
                        exp.statusColor = '#F44336';
                        exp.isOverdue = true;
                        exp.referenceMonth = monthStr; // e.g. "2026-07"

                        let calcInstallment = row.current_installment;
                        if (row.type === 'VARIABLE' && row.start_date && row.total_installments) {
                            const diffM = (currY - startYear) * 12 + (currM - startMonth);
                            calcInstallment = diffM + 1;
                            exp.currentInstallment = calcInstallment;
                            exp.installmentLabel = `Parcela ${calcInstallment}/${row.total_installments}`;
                        } else {
                            exp.currentInstallment = calcInstallment;
                            exp.installmentLabel = null;
                        }

                        // Modify ID so it's unique in the frontend list
                        exp.id = `${row.id}_${monthStr}`;
                        expenses.push(exp);
                    }
                }

                currM++;
                if (currM > 12) {
                    currM = 1;
                    currY++;
                }
            }

            // 2. GENERATE CURRENT MONTH BILL (if it falls within active range)
            // Se o mês navegado é anterior a quando a conta começou (start_date, ou
            // created_at quando start_date não foi informado), ela nem existia ainda —
            // não gera ocorrência nenhuma. Sem isso, uma conta FIXED criada em agosto
            // aparecia como "Atrasado" ao navegar pra julho, mês em que ela nem existia.
            let isCurrentValid = !((year < startYear) || (year === startYear && month < startMonth));
            if (isCurrentValid && row.type === 'VARIABLE' && row.start_date && row.total_installments) {
                const startDate = new Date(row.start_date);
                const diffMonths = (year - startDate.getFullYear()) * 12 + (month - (startDate.getMonth() + 1));
                if (diffMonths >= row.total_installments || diffMonths < 0) {
                    isCurrentValid = false;
                }
            }

            if (isCurrentValid) {
                const currentExp = getBaseExpenseObj();
                let status = 'Pendente';
                let statusColor = '#2196F3'; // Azul

                // Toda ocorrência carrega a competência que representa — não só as
                // geradas pelo loop de "atrasados" (seção 1). Sem isso, vincular uma
                // transação a partir do card do mês corrente (navegando direto pra ele,
                // em vez de vê-lo como "atrasado" resumido num mês futuro) não tinha como
                // informar o backend qual mês estava sendo fechado, e o card não fechava
                // se a transação escolhida tivesse data de outro mês (comum: usuário paga
                // atrasado só quando cai o próximo salário, já no mês seguinte).
                const currentMonthStr = `${year}-${String(month).padStart(2, '0')}`;
                currentExp.referenceMonth = currentMonthStr;

                // Compare using actual dates
                const today = new Date();
                // Set hours to 0 for fair date comparison
                today.setHours(0,0,0,0);
                const dueFullDate = new Date(year, month - 1, row.due_day);

                // "Pago" tanto por transação vinculada com data no mês exato quanto por
                // fechamento manual da competência (bill_manual_payments) — mesmo critério
                // usado pelas ocorrências atrasadas históricas (paidMap).
                const isPaidViaManualClose = Boolean(paidMap[row.id] && paidMap[row.id].has(currentMonthStr));

                if (row.is_paid_this_month > 0 || isPaidViaManualClose) {
                    status = 'Pago';
                    statusColor = '#4CAF50'; // Verde
                    // Mostra o valor realmente pago (soma das transações vinculadas nesse mês),
                    // não o valor padrão configurado na conta — mensalidades como convênio
                    // variam mês a mês, e o valor da transação é a fonte da verdade.
                    // Isso não altera rb.amount, só a exibição desse mês específico.
                    if (row.paid_amount_this_month != null) {
                        currentExp.amount = row.paid_amount_this_month;
                        currentExp.rawAmount = row.paid_amount_this_month;
                    }
                } else if (dueFullDate < today) {
                    status = 'Atrasado';
                    statusColor = '#F44336'; // Vermelho
                } else {
                    const diffTime = dueFullDate.getTime() - today.getTime();
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    if (diffDays <= 5 && diffDays >= 0) {
                        status = 'Vence em breve';
                        statusColor = '#FF9800'; // Laranja
                    }
                }

                currentExp.status = status;
                currentExp.statusColor = statusColor;
                currentExp.isOverdue = false;
                
                let calculatedInstallment = row.current_installment;
                if (row.type === 'VARIABLE' && row.start_date && row.total_installments) {
                    const startDate = new Date(row.start_date);
                    const diffMonths = (year - startDate.getFullYear()) * 12 + (month - (startDate.getMonth() + 1));
                    calculatedInstallment = diffMonths + 1;
                    if (calculatedInstallment < 1) calculatedInstallment = 1;
                    currentExp.currentInstallment = calculatedInstallment;
                    currentExp.installmentLabel = `Parcela ${calculatedInstallment}/${row.total_installments}`;
                } else {
                    currentExp.currentInstallment = calculatedInstallment;
                    currentExp.installmentLabel = null;
                }

                expenses.push(currentExp);
            }
        }
            // Fetch Credit Cards and sum their transactions for the month
            let creditCards = await queryPromise(`
                SELECT id, name, closing_day, due_day, color_hex, member_id
                FROM accounts
                WHERE family_id = ? AND is_credit = 1
            `, [familyId]);

            // Mesma regra de visibilidade por dono usada pra recurring_bills acima
            // (linha ~90): conta sem member_id é da casa (aparece pra todo mundo);
            // com member_id só aparece pra quem está na lista. Sem isso, a fatura
            // de um cartão pessoal de um membro aparecia pra família inteira.
            if (currentUserId != null) {
                creditCards = creditCards.filter(card => {
                    const memIds = parseMemberIds(card.member_id);
                    return memIds.length === 0 || memIds.includes(currentUserId);
                });
            }

            // Mesma fórmula usada em homeController.js pro badge "Contas Fixas a Pagar" —
            // desloca a transação pro mês da fatura em que ela realmente cai (soma 1 mês se
            // caiu depois do fechamento; mais 1 se o vencimento é antes do fechamento, cartão
            // com ciclo "invertido"). A versão antiga daqui (com OR/AND por dia do mês) tinha
            // um buraco: nunca capturava "mês anterior, dia >= fechamento" no caso comum de
            // vencimento >= fechamento — por isso faturas como a do PicPay (fecha 15, vence 20)
            // sumiam da tela mesmo tendo gasto, mas apareciam certas no total da Home (que já
            // usava essa fórmula certa). Ficando os dois iguais, para de divergir.
            const targetMonthStr = `${year}-${String(month).padStart(2, '0')}`;
            // 3 placeholders (closing_day, due_day, closing_day, nessa ordem) pra preencher
            // toda vez que essa fórmula for usada dentro de uma query.
            const invoiceMonthShiftSql = `
                DATE_ADD(
                    transaction_date,
                    INTERVAL (
                        (CASE WHEN DAY(transaction_date) >= COALESCE(?, 31) THEN 1 ELSE 0 END) +
                        (CASE WHEN COALESCE(?, 1) < COALESCE(?, 31) THEN 1 ELSE 0 END)
                    ) MONTH
                )
            `;

            for (const card of creditCards) {
                const cardTransactions = await queryPromise(`
                    SELECT SUM(amount) as total_spent
                    FROM transactions
                    WHERE account_id = ? AND type = 'EXPENSE'
                    AND DATE_FORMAT(${invoiceMonthShiftSql}, '%Y-%m') = ?
                `, [card.id, card.closing_day, card.due_day, card.closing_day, targetMonthStr]);

                // Also subtract INCOME (refunds)
                const cardIncomes = await queryPromise(`
                    SELECT SUM(amount) as total_refund
                    FROM transactions
                    WHERE account_id = ? AND type = 'INCOME'
                    AND DATE_FORMAT(${invoiceMonthShiftSql}, '%Y-%m') = ?
                `, [card.id, card.closing_day, card.due_day, card.closing_day, targetMonthStr]);

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

                    let cardOwnerName = 'Casa';
                    let cardOwnerAvatars = [];
                    const cardMemIds = parseMemberIds(card.member_id);
                    if (cardMemIds.length > 0) {
                        const foundMembers = cardMemIds.map(id => members.find(m => m.id === id)).filter(Boolean);
                        if (foundMembers.length > 0) {
                            cardOwnerName = foundMembers.map(m => m.name.split(' ')[0]).join(', ');
                            cardOwnerAvatars = foundMembers.map(m => m.avatar_url).filter(Boolean);
                        }
                    }

                    expenses.push({
                        id: `invoice_${card.id}`,
                        title: `Fatura - ${card.name}`,
                        amount: spent,
                        rawAmount: spent,
                        dueDate: card.due_day ? `Dia ${card.due_day}` : 'S/ Data',
                        dueDay: card.due_day || 31,
                        // Sem isso, quem filtra por competência exata (ex: Visão
                        // Mensal por quinzena) descarta a fatura inteira por engano
                        // — ela nunca teve isso preenchido antes.
                        referenceMonth: targetMonthStr,
                        isActive: true,
                        categoryId: null,
                        categoryName: 'Cartão de Crédito',
                        categoryColor: card.color_hex || '#9E9E9E',
                        memberId: card.member_id || null,
                        accountId: card.id,
                        paymentType: 'CREDIT_CARD',
                        ownerName: cardOwnerName,
                        ownerAvatars: cardOwnerAvatars,
                        status: invoiceStatus,
                        statusColor: invoiceColor,
                        type: 'CREDIT_INVOICE'
                    });
                }
            }
            
            // Sort expenses again to include invoices in the correct due day order
            expenses.sort((a, b) => a.dueDay - b.dueDay);

            return expenses;
    } catch (err) {
        console.error('Erro ao calcular contas fixas do mês:', err);
        throw err;
    }
}

exports.computeExpensesForMonth = computeExpensesForMonth;

exports.getFixedExpenses = async (req, res) => {
    const familyId = req.user.family_id;
    const filterType = req.query.type;
    const month = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1;
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();

    // scope=family devolve as contas de TODA a família, sem filtrar por dono —
    // usado por telas que comparam/somam entre membros (ex: Carteira), onde
    // filtrar pelo usuário logado faria a tela variar dependendo de quem está
    // vendo, mesmo mostrando dados que deveriam ser os mesmos pra todo mundo.
    const currentUserId = req.query.scope === 'family' ? null : req.user.id;

    try {
        const expenses = await computeExpensesForMonth(familyId, month, year, filterType, currentUserId);
        res.json({ expenses });
    } catch (err) {
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

// Mark an overdue bill as paid manually (without a real transaction)
exports.markAsPaid = (req, res) => {
    const familyId = req.user.family_id;
    const billId = req.params.id;
    const { referenceMonth } = req.body; // e.g. "2026-07"

    if (!referenceMonth || !/^\d{4}-\d{2}$/.test(referenceMonth)) {
        return res.status(400).json({ error: 'referenceMonth inválido. Use o formato YYYY-MM.' });
    }

    // Verify the bill belongs to this family
    db.get(`SELECT id FROM recurring_bills WHERE id = ? AND family_id = ?`, [billId, familyId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Conta não encontrada.' });

        db.run(
            `INSERT IGNORE INTO bill_manual_payments (family_id, recurring_bill_id, reference_month) VALUES (?, ?, ?)`,
            [familyId, billId, referenceMonth],
            function(err2) {
                if (err2) return res.status(500).json({ error: 'Erro ao marcar como pago.' });
                res.json({ message: 'Marcado como pago com sucesso.' });
            }
        );
    });
};

// Mark a specific installment (modelo novo de parcelas) as paid manually, sem lançamento.
exports.markInstallmentAsPaid = async (req, res) => {
    const familyId = req.user.family_id;
    const installmentId = req.params.installmentId;

    try {
        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT ri.id FROM recurring_bill_installments ri
                 INNER JOIN recurring_bills rb ON rb.id = ri.recurring_bill_id
                 WHERE ri.id = ? AND rb.family_id = ?`,
                [installmentId, familyId],
                (err, r) => err ? reject(err) : resolve(r)
            );
        });
        if (!row) return res.status(404).json({ error: 'Parcela não encontrada.' });

        await runPromise(`UPDATE recurring_bill_installments SET status = 'PAID' WHERE id = ?`, [installmentId]);
        triggerUpdate(familyId);
        res.json({ message: 'Marcado como pago com sucesso.' });
    } catch (err) {
        console.error('Erro ao marcar parcela como paga:', err);
        res.status(500).json({ error: 'Erro ao marcar como pago.' });
    }
};

// Desfaz o "marcar como pago" manual de uma parcela específica.
exports.unmarkInstallmentAsPaid = async (req, res) => {
    const familyId = req.user.family_id;
    const installmentId = req.params.installmentId;

    try {
        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT ri.id, ri.transaction_id FROM recurring_bill_installments ri
                 INNER JOIN recurring_bills rb ON rb.id = ri.recurring_bill_id
                 WHERE ri.id = ? AND rb.family_id = ?`,
                [installmentId, familyId],
                (err, r) => err ? reject(err) : resolve(r)
            );
        });
        if (!row) return res.status(404).json({ error: 'Parcela não encontrada.' });

        // A transação em si (quando veio de "Vincular transação") tem seu próprio
        // recurring_bill_id apontando pra essa conta — sem limpar isso aqui, a
        // parcela volta a "Pendente" mas a transação continua marcada como se
        // pertencesse a essa conta, órfã da mesma forma que o modelo antigo tinha.
        if (row.transaction_id) {
            await runPromise(`UPDATE transactions SET recurring_bill_id = NULL WHERE id = ?`, [row.transaction_id]);
        }

        await runPromise(`UPDATE recurring_bill_installments SET status = 'PENDING', transaction_id = NULL WHERE id = ?`, [installmentId]);
        triggerUpdate(familyId);
        res.json({ message: 'Pagamento removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao desmarcar parcela:', err);
        res.status(500).json({ error: 'Erro ao desmarcar pagamento.' });
    }
};

// Desfaz o "pago" de uma competência (mês) de uma conta do modelo antigo
// (mensal, sem lista de parcelas explícitas). Uma conta pode estar "Pago" por
// dois caminhos bem diferentes — fechamento manual ("Marcar como Pago, Sem
// Lançamento", tabela bill_manual_payments) ou uma transação de verdade
// vinculada (campo transactions.recurring_bill_id, via "Vincular transação"
// ou lançamento direto) — então desfaz os dois, senão o "Desfazer pagamento"
// resolvia um caso e a conta continuava aparecendo "Pago" pelo outro.
exports.unmarkAsPaid = async (req, res) => {
    const familyId = req.user.family_id;
    const billId = req.params.id;
    const { referenceMonth } = req.body;

    if (!referenceMonth || !/^\d{4}-\d{2}$/.test(referenceMonth)) {
        return res.status(400).json({ error: 'referenceMonth inválido. Use o formato YYYY-MM.' });
    }

    try {
        await runPromise(
            `DELETE FROM bill_manual_payments WHERE family_id = ? AND recurring_bill_id = ? AND reference_month = ?`,
            [familyId, billId, referenceMonth]
        );

        // Desvincula (não apaga) qualquer transação lançada nesse mês que aponte
        // pra essa conta — a transação em si continua existindo normalmente,
        // só deixa de "fechar" essa competência.
        await runPromise(
            `UPDATE transactions t
             JOIN accounts a ON a.id = t.account_id
             SET t.recurring_bill_id = NULL
             WHERE a.family_id = ? AND t.recurring_bill_id = ? AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?`,
            [familyId, billId, referenceMonth]
        );

        triggerUpdate(familyId);
        res.json({ message: 'Pagamento desfeito com sucesso.' });
    } catch (err) {
        console.error('Erro ao desmarcar pagamento:', err);
        res.status(500).json({ error: 'Erro ao desmarcar pagamento.' });
    }
};

// Valida e normaliza a lista de parcelas vinda do app: [{ amount, dueDate }, ...].
// Retorna null se a lista não vier ou vier vazia (conta variável no modelo antigo).
function normalizeInstallments(installments) {
    if (!Array.isArray(installments) || installments.length === 0) return null;
    const normalized = installments
        .map((inst) => ({
            amount: parseFloat(inst.amount),
            dueDate: inst.dueDate,
        }))
        .filter((inst) => !isNaN(inst.amount) && /^\d{4}-\d{2}-\d{2}$/.test(inst.dueDate || ''));
    if (normalized.length === 0) return null;
    normalized.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return normalized;
}

exports.createFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    let { name, amount, dueDay, categoryId, memberId, accountId, paymentType, type, totalInstallments, startDate, installments } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const expenseType = type || 'FIXED';
    const normalizedInstallments = expenseType === 'VARIABLE' ? normalizeInstallments(installments) : null;

    let endDate = null;
    let currentInstallment = 1;

    if (normalizedInstallments) {
        // Modelo novo: start_date/end_date/total_installments viram DERIVADOS da lista
        // de parcelas — cada parcela já carrega sua própria data e valor reais.
        startDate = normalizedInstallments[0].dueDate;
        endDate = normalizedInstallments[normalizedInstallments.length - 1].dueDate;
        totalInstallments = normalizedInstallments.length;
    } else if (totalInstallments) {
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
        0, // is_auto_pay — recurso removido (não havia automação real por trás)
        accountId || null,
        paymentType || null,
        expenseType,
        totalInstallments || null,
        currentInstallment,
        startDate || null,
        endDate
    ];

    try {
        const result = await runPromise(query, params);
        const billId = result.lastID;

        if (normalizedInstallments) {
            for (let i = 0; i < normalizedInstallments.length; i++) {
                const inst = normalizedInstallments[i];
                await runPromise(
                    `INSERT INTO recurring_bill_installments (recurring_bill_id, installment_number, amount, due_date) VALUES (?, ?, ?, ?)`,
                    [billId, i + 1, inst.amount, inst.dueDate]
                );
            }
        }

        triggerUpdate(familyId);
        res.status(201).json({ message: 'Conta fixa criada com sucesso', id: billId });
    } catch (err) {
        console.error('Erro ao criar conta fixa:', err);
        res.status(500).json({ error: 'Erro ao criar conta fixa' });
    }
};

exports.updateFixedExpense = async (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;
    let { name, amount, dueDay, isActive, categoryId, memberId, accountId, paymentType, type, totalInstallments, currentInstallment, startDate, endDate, installments } = req.body;

    if (paymentType === 'CASH' && !accountId) {
        accountId = await getOrCreateWalletAccountId(familyId);
    }

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const expenseType = type || 'FIXED';
    // `installments` só vem preenchido quando o app está de fato editando a lista de
    // parcelas (tela de Conta Variável nova). Se vier `undefined`, não mexe em nada
    // que já esteja salvo em recurring_bill_installments.
    const normalizedInstallments = expenseType === 'VARIABLE' ? normalizeInstallments(installments) : null;
    if (expenseType === 'VARIABLE' && normalizedInstallments) {
        startDate = normalizedInstallments[0].dueDate;
        endDate = normalizedInstallments[normalizedInstallments.length - 1].dueDate;
        totalInstallments = normalizedInstallments.length;
    }

    const query = `
        UPDATE recurring_bills
        SET name = ?, amount = ?, due_day = ?, is_active = ?, category_id = ?, member_id = ?, account_id = ?, payment_type = ?,
            type = ?, total_installments = ?, current_installment = ?, start_date = ?, end_date = ?
        WHERE id = ? AND family_id = ?
    `;
    const params = [
        name,
        amount || null,
        dueDay,
        isActive !== undefined ? (isActive ? 1 : 0) : 1,
        categoryId,
        memberId || null,
        accountId || null,
        paymentType || null,
        expenseType,
        totalInstallments || null,
        currentInstallment || 1,
        startDate || null,
        endDate || null,
        expenseId,
        familyId
    ];

    try {
        const result = await runPromise(query, params);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Conta fixa não encontrada' });
        }

        if (normalizedInstallments) {
            // Reconciliação por posição, preservando parcelas já PAGAS intactas — nunca
            // apaga/recria tudo, senão qualquer edição desmarcaria pagamentos já feitos.
            const existing = await allPromise(
                `SELECT id, installment_number, amount, due_date, status, transaction_id
                 FROM recurring_bill_installments WHERE recurring_bill_id = ? ORDER BY installment_number ASC`,
                [expenseId]
            );

            for (let i = 0; i < normalizedInstallments.length; i++) {
                const inst = normalizedInstallments[i];
                const existingRow = existing[i];

                if (existingRow && existingRow.status === 'PAID') {
                    // Já paga: não mexe em valor/data/status, só garante a posição certa.
                    await runPromise(`UPDATE recurring_bill_installments SET installment_number = ? WHERE id = ?`, [i + 1, existingRow.id]);
                    continue;
                }

                if (existingRow) {
                    await runPromise(
                        `UPDATE recurring_bill_installments SET installment_number = ?, amount = ?, due_date = ? WHERE id = ?`,
                        [i + 1, inst.amount, inst.dueDate, existingRow.id]
                    );
                } else {
                    // Parcela nova de verdade (não existia linha nenhuma pra ela ainda) — pode
                    // ser a primeira vez que essa conta ganha uma lista de parcelas explícitas,
                    // vindo do modelo antigo (mensal, sem parcela própria), onde o pagamento era
                    // rastreado só por transactions.recurring_bill_id. Sem essa checagem, uma
                    // parcela cujo mês já tinha sido paga no modelo antigo nascia PENDING do
                    // zero — a transação continuava vinculada à conta, só não a essa parcela
                    // específica, e o card virava "Atrasado"/"Pendente" de novo do nada.
                    const priorTx = await allPromise(
                        `SELECT id FROM transactions WHERE recurring_bill_id = ? AND DATE_FORMAT(transaction_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m') LIMIT 1`,
                        [expenseId, inst.dueDate]
                    );
                    const matchedTxId = priorTx[0] ? priorTx[0].id : null;

                    await runPromise(
                        `INSERT INTO recurring_bill_installments (recurring_bill_id, installment_number, amount, due_date, status, transaction_id) VALUES (?, ?, ?, ?, ?, ?)`,
                        [expenseId, i + 1, inst.amount, inst.dueDate, matchedTxId ? 'PAID' : 'PENDING', matchedTxId]
                    );
                }
            }

            // Parcelas que sobraram (lista nova ficou menor): só remove as que não estão pagas.
            if (existing.length > normalizedInstallments.length) {
                const toRemove = existing.slice(normalizedInstallments.length).filter(e => e.status !== 'PAID');
                for (const row of toRemove) {
                    await runPromise(`DELETE FROM recurring_bill_installments WHERE id = ?`, [row.id]);
                }
            }
        }

        triggerUpdate(familyId);
        res.json({ message: 'Conta fixa atualizada com sucesso' });
    } catch (err) {
        console.error('Erro ao atualizar conta fixa:', err);
        res.status(500).json({ error: 'Erro ao atualizar conta fixa' });
    }
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

// Lista as parcelas explícitas (modelo novo) de uma conta Variável — usado pelo app
// pra pré-preencher a lista inteira ao abrir "Editar", já que cada card na tela de
// Gerenciar representa só UMA parcela.
exports.getInstallmentsForBill = async (req, res) => {
    const familyId = req.user.family_id;
    const billId = req.params.id;

    try {
        const bill = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM recurring_bills WHERE id = ? AND family_id = ?`, [billId, familyId], (err, r) => err ? reject(err) : resolve(r));
        });
        if (!bill) return res.status(404).json({ error: 'Conta não encontrada.' });

        const installments = await allPromise(
            `SELECT id, installment_number, amount, due_date, status FROM recurring_bill_installments WHERE recurring_bill_id = ? ORDER BY due_date ASC`,
            [billId]
        );
        res.json({ installments: installments || [] });
    } catch (err) {
        console.error('Erro ao buscar parcelas da conta:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
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
    const { transactionId, recurringBillId, installmentId, referenceMonth } = req.body;

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

            // Se o vínculo é pra uma ocorrência atrasada (referenceMonth), a transação
            // escolhida quase nunca cai no mês de referência dessa ocorrência — o usuário
            // geralmente paga uma conta de julho com uma transação lançada em agosto.
            // O cálculo de "atrasado" (paidMap) casa por mês da transação, então sem isso
            // a conta continuava aparecendo como pendente mesmo após vincular. Gravamos
            // também em bill_manual_payments pra fechar esse mês específico, igual ao
            // fluxo de "Marcar como Pago (Sem Lançamento)".
            const proceed = () => continueLinking();
            if (referenceMonth && /^\d{4}-\d{2}$/.test(referenceMonth)) {
                db.run(
                    `INSERT IGNORE INTO bill_manual_payments (family_id, recurring_bill_id, reference_month) VALUES (?, ?, ?)`,
                    [familyId, recurringBillId, referenceMonth],
                    function(errManual) {
                        if (errManual) console.error('Erro ao registrar pagamento manual do mês de referência:', errManual);
                        proceed();
                    }
                );
            } else {
                proceed();
            }

            function continueLinking() {
            // Modelo novo (parcela explícita): marca a parcela específica como paga e
            // vinculada a essa transação. Não mexe em current_installment/is_active —
            // isso é coisa do modelo antigo (mensal, sem lista de parcelas).
            if (installmentId) {
                db.run(
                    `UPDATE recurring_bill_installments SET status = 'PAID', transaction_id = ? WHERE id = ? AND recurring_bill_id = ?`,
                    [transactionId, installmentId, recurringBillId],
                    function(errInst) {
                        if (errInst) console.error('Erro ao marcar parcela como paga:', errInst);
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
                );
                return;
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
            }
        });
    });
};
