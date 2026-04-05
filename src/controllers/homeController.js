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

        // 1. Contas e Saldos
        const accounts = await queryPromise(
            `SELECT id, name, current_balance, type, bank_code, color_hex, card_last_digits FROM accounts WHERE family_id = ?`, 
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
        const totalsData = await queryPromise(
            `SELECT t.type, SUM(t.amount) as total 
             FROM transactions t 
             JOIN accounts a ON t.account_id = a.id 
             WHERE a.family_id = ? AND strftime('%Y-%m', t.transaction_date) = ? 
             GROUP BY t.type`,
            [familyId, currentMonth]
        );

        let income = 0;
        let expense = 0;
        totalsData.forEach(row => {
            if (row.type === 'INCOME') income = row.total;
            if (row.type === 'EXPENSE') expense = row.total;
        });

        // 2.5 Despesas por Categoria para o Gráfico de Barras em Camadas
        const categoryExpensesRaw = await queryPromise(
            `SELECT c.id, c.name, c.color_hex, SUM(t.amount) as total
             FROM transactions t
             JOIN categories c ON t.category_id = c.id
             JOIN accounts a ON t.account_id = a.id
             WHERE a.family_id = ? AND t.type = 'EXPENSE' AND strftime('%Y-%m', t.transaction_date) = ?
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
                    t.account_id, t.destination_account_id, t.category_id, t.member_id,
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

        // 5. Dados do Usuário Atual
        const [currentUser] = await queryPromise(
            `SELECT id, name, avatar_url, is_admin FROM members WHERE id = ?`,
            [req.user.id]
        );

        // 6. Dados da Família
        const [familyInfo] = await queryPromise(
            `SELECT name FROM families WHERE id = ?`,
            [familyId]
        );

        // 7. Total de Contas Fixas Recorrentes (Ativas)
        const [recurringTotals] = await queryPromise(
            `SELECT SUM(amount) as total FROM recurring_bills WHERE family_id = ? AND is_active = 1`,
            [familyId]
        );
        const fixedExpensesTotal = recurringTotals.total || 0;

        res.status(200).json({
            user: currentUser,
            familyName: familyInfo ? familyInfo.name : 'Minha Família',
            totalBalance,
            totalInvestments,
            creditCardDebt,
            accounts,
            income,
            expense,
            fixedExpensesTotal,
            categoryExpenses,
            members,
            recentTransactions
        });

    } catch (error) {
        console.error('Erro no getHomeData:', error);
        res.status(500).json({ error: 'Erro ao carregar dados da Home.' });
    }
};