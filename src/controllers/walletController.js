const db = require('../config/database');

exports.getWalletData = (req, res) => {
    const familyId = req.user.family_id;

    // Busca todas as contas da família
    const queryAccounts = `
        SELECT a.id, a.name, a.type, a.current_balance, a.member_id, m.name as member_name, m.avatar_url
        FROM accounts a
        LEFT JOIN members m ON a.member_id = m.id
        WHERE a.family_id = ?
    `;

    db.all(queryAccounts, [familyId], (err, accounts) => {
        if (err) {
            console.error('Erro ao buscar contas:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        let totalBalance = 0;
        let sharedBalance = 0;
        const membersMap = {}; // Para armazenar o saldo calculado de cada membro

        // 1. Inicializar o saldo base de cada membro com as contas pessoais
        accounts.forEach(acc => {
            if (acc.type !== 'INVESTMENT') {
                totalBalance += acc.current_balance;
            }

            if (acc.type === 'SHARED') {
                sharedBalance += acc.current_balance;
            } else if (acc.type === 'PERSONAL' && acc.member_id) {
                if (!membersMap[acc.member_id]) {
                    membersMap[acc.member_id] = {
                        memberId: acc.member_id,
                        memberName: acc.member_name,
                        avatarUrl: acc.avatar_url,
                        balance: 0,
                        personalBalance: 0,
                        transactions: []
                    };
                }
                membersMap[acc.member_id].balance += acc.current_balance;
                membersMap[acc.member_id].personalBalance += acc.current_balance;
            }
        });

        // Garantir que todos os membros da família estejam no mapa (mesmo com saldo 0)
        db.all(`SELECT id, name, avatar_url FROM members WHERE family_id = ?`, [familyId], (err, members) => {
            if (!err && members) {
                members.forEach(m => {
                    if (!membersMap[m.id]) {
                        membersMap[m.id] = {
                            memberId: m.id,
                            memberName: m.name,
                            avatarUrl: m.avatar_url,
                            balance: 0,
                            personalBalance: 0,
                            transactions: []
                        };
                    }
                });
            }

            // 2. Buscar todas as transações para aplicar o rateio
            const queryTransactions = `
                SELECT t.id, t.description, t.transaction_date, t.amount, t.type, t.member_id, a.member_id as payer_id
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.family_id = ? AND t.type != 'TRANSFER'
            `;

            db.all(queryTransactions, [familyId], (err, transactions) => {
                if (err) {
                    console.error('Erro ao buscar transações para rateio:', err);
                    return res.status(500).json({ error: 'Erro interno no servidor' });
                }

                transactions.forEach(t => {
                    const amount = t.amount;
                    const payer_id = t.payer_id; // Pode ser null se a conta for SHARED
                    let owners = [];

                    try {
                        const parsed = JSON.parse(t.member_id);
                        if (Array.isArray(parsed)) {
                            owners = parsed;
                        } else {
                            owners = [parsed];
                        }
                    } catch (e) {
                        // Fallback para int antigo
                        if (t.member_id) owners = [parseInt(t.member_id)];
                    }

                    if (owners.length > 0) {
                        const share = amount / owners.length;
                        owners.forEach(owner => {
                            if (owner != payer_id) {
                                if (t.type === 'EXPENSE') {
                                    // O responsável (owner) deve ao pagador (payer)
                                    if (owner && membersMap[owner]) {
                                        membersMap[owner].balance -= share;
                                        membersMap[owner].transactions.push({
                                            id: t.id, description: t.description, date: t.transaction_date, amount: -share, detail: 'Sua parte na despesa'
                                        });
                                    }
                                    if (payer_id && membersMap[payer_id]) {
                                        membersMap[payer_id].balance += share;
                                        membersMap[payer_id].transactions.push({
                                            id: t.id, description: t.description, date: t.transaction_date, amount: share, detail: 'Pagou a parte de outro'
                                        });
                                    }
                                } else if (t.type === 'INCOME') {
                                    // O pagador (payer) deve repassar a receita ao responsável (owner)
                                    if (owner && membersMap[owner]) {
                                        membersMap[owner].balance += share;
                                        membersMap[owner].transactions.push({
                                            id: t.id, description: t.description, date: t.transaction_date, amount: share, detail: 'Sua parte na receita'
                                        });
                                    }
                                    if (payer_id && membersMap[payer_id]) {
                                        membersMap[payer_id].balance -= share;
                                        membersMap[payer_id].transactions.push({
                                            id: t.id, description: t.description, date: t.transaction_date, amount: -share, detail: 'Recebeu a parte de outro'
                                        });
                                    }
                                }
                            }
                        });
                    }
                });

                res.json({
                    totalBalance,
                    sharedBalance,
                    individualBalances: Object.values(membersMap)
                });
            });
        });
    });
};
