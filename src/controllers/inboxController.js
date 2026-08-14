const db = require('../config/database');
const { extractReceiptWithAI } = require('../services/geminiService');
const { triggerUpdate } = require('../services/financialEventService');

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
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

exports.processUpload = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    try {
        // Obter categorias e contas
        const categories = await getQuery('SELECT id, name, type FROM categories WHERE family_id = ?', [familyId]);
        const accounts = await getQuery('SELECT id, name FROM accounts WHERE family_id = ?', [familyId]);

        // Enviar para a IA
        const aiResult = await extractReceiptWithAI(fileBuffer, mimeType, categories, accounts);

        if (!aiResult) {
            return res.status(500).json({ error: 'Falha ao processar o comprovante com Inteligência Artificial.' });
        }

        let accountId = aiResult.accountId;

        // Se a IA detectou que precisa criar a conta
        if (aiResult.shouldCreateAccount && aiResult.newAccountName) {
            const insertAccount = await runQuery(
                'INSERT INTO accounts (family_id, name, balance, type) VALUES (?, ?, 0, ?)', 
                [familyId, aiResult.newAccountName, 'CHECKING']
            );
            accountId = insertAccount.lastID;
        }

        // Caso a IA falhe em associar categoria, usar fallback genérico para não quebrar a inserção
        let categoryId = aiResult.categoryId;
        if (!categoryId) {
            const fallbackCat = await getQuery('SELECT id FROM categories WHERE family_id = ? AND type = ? LIMIT 1', [familyId, aiResult.type || 'EXPENSE']);
            if (fallbackCat.length > 0) {
                categoryId = fallbackCat[0].id;
            }
        }

        // Se mesmo assim accountId não existir, forçar a conta carteira
        if (!accountId) {
            const { getOrCreateWalletAccountId } = require('../utils/walletHelper');
            accountId = await getOrCreateWalletAccountId(familyId);
        }

        const type = aiResult.type || 'EXPENSE';
        const description = aiResult.description || 'Comprovante recebido';
        const amount = aiResult.amount || 0.0;
        const date = aiResult.date || new Date().toISOString().split('T')[0];

        const insertQuery = `
            INSERT INTO transactions (account_id, destination_account_id, member_id, category_id, amount, type, description, transaction_date, is_ai_processed, payment_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await runQuery(insertQuery, [
            accountId,
            null,
            JSON.stringify([memberId]), 
            categoryId,
            amount,
            type,
            description,
            date,
            true, 
            'PIX'
        ]);

        triggerUpdate(familyId);

        // Disparar evento WebSocket para o Frontend atualizar a tela em tempo real
        const { getIo } = require('../websockets/socket');
        const io = getIo();
        io.to(`family_${familyId}`).emit('data_updated', {
            message: 'Comprovante processado pela IA!',
            source: 'inbox_ai'
        });

        res.status(200).json({ message: 'Comprovante processado e transação cadastrada com sucesso!' });
    } catch (error) {
        console.error('Erro no processUpload:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};
