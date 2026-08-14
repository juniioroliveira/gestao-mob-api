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
        const base64Data = fileBuffer.toString('base64');
        const fileName = req.file.originalname || 'comprovante.jpg';

        // 1. Salvar no banco como PENDING
        const insertDocQuery = `
            INSERT INTO inbox_documents (family_id, member_id, file_path, file_name, file_type, file_base64, status)
            VALUES (?, ?, 'db_base64', ?, ?, ?, 'PENDING')
        `;
        const result = await runQuery(insertDocQuery, [familyId, memberId, fileName, mimeType, base64Data]);
        const documentId = result.lastID;

        // 2. Retornar SUCESSO imediato para o celular
        res.status(200).json({ 
            message: 'Comprovante recebido! Processando com IA em segundo plano...',
            documentId
        });

        // Emitir evento para o Frontend de que um novo documento chegou
        const { getIo } = require('../websockets/socket');
        const io = getIo();
        if (io) {
            io.to(`family_${familyId}`).emit('data_updated', {
                source: 'documents',
                action: 'created'
            });
        }

        // 3. Chamar processamento em background (solto)
        processDocumentAsync(documentId, familyId, memberId, fileBuffer, mimeType).catch(err => {
            console.error('[Background AI] Erro fatal no processDocumentAsync:', err);
        });

    } catch (error) {
        console.error('Erro no processUpload:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

/**
 * Função rodando em segundo plano (background job)
 */
async function processDocumentAsync(documentId, familyId, memberId, fileBuffer, mimeType) {
    try {
        console.log(`[Background AI] Iniciando processamento do documento #${documentId}...`);
        
        // Obter categorias e contas
        const categories = await getQuery('SELECT id, name, type FROM categories WHERE family_id = ?', [familyId]);
        const accounts = await getQuery('SELECT id, name FROM accounts WHERE family_id = ?', [familyId]);

        // Enviar para a IA
        const aiResult = await extractReceiptWithAI(fileBuffer, mimeType, categories, accounts);

        if (!aiResult) {
            console.error(`[Background AI] Falha ao ler documento #${documentId}`);
            await runQuery('UPDATE inbox_documents SET status = "FAILED" WHERE id = ?', [documentId]);
            return;
        }

        let accountId = aiResult.accountId;

        if (aiResult.shouldCreateAccount && aiResult.newAccountName) {
            const insertAccount = await runQuery(
                'INSERT INTO accounts (family_id, name, current_balance, type) VALUES (?, ?, 0, ?)', 
                [familyId, aiResult.newAccountName, 'CHECKING']
            );
            accountId = insertAccount.lastID;
        }

        let categoryId = aiResult.categoryId;
        if (!categoryId) {
            const fallbackCat = await getQuery('SELECT id FROM categories WHERE family_id = ? AND type = ? LIMIT 1', [familyId, (aiResult.type || 'EXPENSE').toUpperCase()]);
            if (fallbackCat.length > 0) {
                categoryId = fallbackCat[0].id;
            }
        }

        if (!accountId) {
            const { getOrCreateWalletAccountId } = require('../utils/walletHelper');
            accountId = await getOrCreateWalletAccountId(familyId);
        }

        const type = (aiResult.type || 'EXPENSE').toUpperCase();
        const description = aiResult.description || 'Comprovante recebido';
        const rawAmount = aiResult.amount ? String(aiResult.amount).replace(',', '.') : '0.0';
        const amount = parseFloat(rawAmount) || 0.0;
        
        let date = aiResult.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            date = new Date().toISOString().split('T')[0];
        }

        // Fake Req e Res para o transactionController
        const mockReq = {
            user: { id: memberId, family_id: familyId },
            body: {
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
            }
        };

        let transactionCreatedId = null;
        const mockRes = {
            status: (code) => ({
                json: async (data) => {
                    console.log(`[Background AI] Resposta do transactionController (Code: ${code}):`, data);
                    const transactionCreatedId = data.id || null;
                    
                    if (code >= 200 && code < 300) {
                        // Sucesso
                        await runQuery(
                            'UPDATE inbox_documents SET status = "PROCESSED", extracted_data = ?, transaction_id = ? WHERE id = ?', 
                            [JSON.stringify(aiResult), transactionCreatedId, documentId]
                        ).catch(err => console.error('Erro update doc:', err));
                    } else {
                        // Falha de validação ou erro (ex: valor nulo)
                        let validationError = data.error || data.message || 'Dados insuficientes extraídos pela IA.';
                        await runQuery(
                            'UPDATE inbox_documents SET status = "FAILED", extracted_data = ?, error_message = ? WHERE id = ?', 
                            [JSON.stringify(aiResult), validationError, documentId]
                        ).catch(err => console.error('Erro update doc:', err));
                    }

                    const { getIo } = require('../websockets/socket');
                    const io = getIo();
                    if (io) {
                        io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'updated' });
                    }
                }
            })
        };

        const transactionController = require('./transactionController');
        await transactionController.createTransaction(mockReq, mockRes);

    } catch (err) {
        console.error(`[Background AI] Erro ao processar documento #${documentId}:`, err);
        
        let extractedJson = null;
        try { if (typeof aiResult !== 'undefined' && aiResult) extractedJson = JSON.stringify(aiResult); } catch (e) {}

        let errorMessage = err.message || 'Erro desconhecido';
        if (errorMessage.includes('429')) errorMessage = 'Excesso de requisições à IA (Tente novamente mais tarde).';
        else if (errorMessage.includes('503')) errorMessage = 'O servidor da IA está sobrecarregado.';
        else errorMessage = `Falha na leitura: ${errorMessage.substring(0, 50)}...`;

        await runQuery(
            'UPDATE inbox_documents SET status = "FAILED", extracted_data = ?, error_message = ? WHERE id = ?', 
            [extractedJson, errorMessage, documentId]
        ).catch(() => {});
        
        const { getIo } = require('../websockets/socket');
        const io = getIo();
        if (io) {
            io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'failed' });
        }
    }
}

exports.processDocumentAsync = processDocumentAsync;
