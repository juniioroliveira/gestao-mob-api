const db = require('../config/database');

const runQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const getQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

exports.getOrCreateWalletAccountId = async (familyId) => {
    // Busca conta chamada 'Carteira' com type 'CASH'
    const findQuery = `SELECT id FROM accounts WHERE family_id = ? AND type = 'CASH' AND name = 'Carteira' LIMIT 1`;
    const wallet = await getQuery(findQuery, [familyId]);
    
    if (wallet) {
        return wallet.id;
    }
    
    // Cria se não existir
    // Para simplificar, member_id será nulo ou podemos buscar um admin
    const insertWallet = `
        INSERT INTO accounts (family_id, member_id, name, type, current_balance, color_hex, is_debit, is_credit) 
        VALUES (?, NULL, 'Carteira', 'CASH', 0.00, '#4CAF50', 1, 0)
    `;
    const res = await runQuery(insertWallet, [familyId]);
    return res.lastID;
};
