const db = require('../config/database');

exports.getWalletData = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT a.id, a.name, a.type, a.current_balance, a.member_id, m.name as member_name, m.avatar_url
        FROM accounts a
        LEFT JOIN members m ON a.member_id = m.id
        WHERE a.family_id = ?
    `;

    db.all(query, [familyId], (err, accounts) => {
        if (err) {
            console.error('Erro ao buscar contas:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        let totalBalance = 0;
        let sharedBalance = 0;
        const individualBalances = [];

        accounts.forEach(acc => {
            if (acc.type !== 'INVESTMENT') {
                totalBalance += acc.current_balance;
            }

            if (acc.type === 'SHARED') {
                sharedBalance += acc.current_balance;
            } else if (acc.type === 'PERSONAL' && acc.member_id) {
                // Tenta encontrar se o membro já existe na lista de individualBalances
                const existingMemberIndex = individualBalances.findIndex(m => m.memberId === acc.member_id);
                
                if (existingMemberIndex >= 0) {
                    // Se o membro já existe, apenas soma o saldo na conta dele
                    individualBalances[existingMemberIndex].balance += acc.current_balance;
                } else {
                    // Se não existe, adiciona ele na lista
                    individualBalances.push({
                        memberId: acc.member_id,
                        memberName: acc.member_name,
                        avatarUrl: acc.avatar_url,
                        balance: acc.current_balance
                    });
                }
            }
        });

        res.json({
            totalBalance,
            sharedBalance,
            individualBalances
        });
    });
};
