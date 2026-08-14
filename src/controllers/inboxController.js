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

        // Mapear a saída da IA para o body esperado pelo transactionController
        req.body = {
            accountId,
            destinationAccountId: null,
            memberId: [memberId],
            categoryId,
            amount,
            type,
            description,
            date,
            paymentType: 'PIX',
            installments: 1,
            is_ai_processed: true
        };

        // Delegar a criação para o controller padrão (garante reuso de atualização de saldo, WebSocket e background AI)
        const transactionController = require('./transactionController');
        return await transactionController.createTransaction(req, res);

    } catch (error) {
        console.error('Erro no processUpload:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};
