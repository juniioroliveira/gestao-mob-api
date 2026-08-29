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

// Mesmo parsing usado em outros controllers (contas fixas, estatísticas) pra
// transactions.member_id / recurring_bills.member_id, que vem como int solto,
// string de int, ou array JSON "[1,2]".
function parseMemberIds(memberIdRaw) {
    if (memberIdRaw === null || memberIdRaw === undefined) return [];
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

// Chave de comparação pro "mesmo recebedor" — minúsculo, sem acento, sem
// pontuação. É aproximado de propósito: "Amil Assistência Médica" e "AMIL
// SAUDE LTDA" não batem 100%, mas a busca por palavra em findHistoricalBillMatch
// cobre esse tipo de variação parcial.
function normalizePayeeKey(name) {
    if (!name) return '';
    return name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Primeira vez que vemos esse recebedor (sem entrada em payee_memory ainda):
// procura nas transações JÁ vinculadas a alguma conta fixa se esse mesmo nome
// já apareceu antes — é o mesmo dado que o usuário gerou manualmente ao usar
// "Vincular transação" na tela de Contas a Pagar. Só sugere se a maioria
// esmagadora dos achados apontar pra mesma conta (evita sugestão errada por
// coincidência de uma palavra comum).
async function findHistoricalBillMatch(familyId, memberId, payeeKey) {
    const words = payeeKey.split(' ').filter(w => w.length >= 4);
    if (words.length === 0) return null;

    const rows = await getQuery(
        `SELECT t.description, t.member_id, t.recurring_bill_id, rb.member_id as bill_member_id
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN recurring_bills rb ON rb.id = t.recurring_bill_id
         WHERE a.family_id = ? AND t.recurring_bill_id IS NOT NULL AND LOWER(t.description) LIKE ?`,
        [familyId, `%${words[0]}%`]
    );

    // Filtra em JS pra quem realmente é dono da transação/conta (mesmo critério
    // de rateio usado em todo o resto) — mais seguro que confiar em JSON_CONTAINS
    // do SQL num campo que às vezes é int solto, às vezes array serializado.
    const relevant = rows.filter(r => {
        const txOwners = parseMemberIds(r.member_id);
        const billOwners = parseMemberIds(r.bill_member_id);
        const ownsTx = txOwners.length === 0 || txOwners.includes(memberId);
        const ownsBill = billOwners.length === 0 || billOwners.includes(memberId);
        return ownsTx && ownsBill;
    });

    if (relevant.length === 0) return null;

    const counts = {};
    relevant.forEach(r => {
        counts[r.recurring_bill_id] = (counts[r.recurring_bill_id] || 0) + 1;
    });
    const [topBillId, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

    return (topCount / relevant.length >= 0.6) ? parseInt(topBillId, 10) : null;
}

// Grava/atualiza o que sabemos sobre esse recebedor. recurringBillId só é
// passado quando já temos uma sugestão pra oferecer — senão mantém o que já
// estava lá (COALESCE), pra não apagar uma confirmação anterior do usuário
// só porque esse documento em particular não achou match nenhum.
async function upsertPayeeMemory({ familyId, memberId, payeeKey, payeeDisplayName, categoryId, accountId, amount, recurringBillId }) {
    if (!payeeKey) return;
    await runQuery(
        `INSERT INTO payee_memory (family_id, member_id, payee_key, payee_display_name, last_category_id, last_account_id, last_amount, recurring_bill_id, occurrences, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
            payee_display_name = VALUES(payee_display_name),
            last_category_id = VALUES(last_category_id),
            last_account_id = VALUES(last_account_id),
            last_amount = VALUES(last_amount),
            recurring_bill_id = COALESCE(VALUES(recurring_bill_id), recurring_bill_id),
            occurrences = occurrences + 1,
            last_seen_at = NOW()`,
        [familyId, memberId, payeeKey, payeeDisplayName, categoryId || null, accountId || null, amount || null, recurringBillId || null]
    );
}

/**
 * Ponto único de entrada pro processamento de um documento recebido na inbox.
 * As duas origens possíveis (Atalho iOS -> upload direto em memória, ou
 * Compartilhamento Android -> arquivo já salvo em disco) só diferem em COMO
 * o arquivo chega até aqui; a partir daqui o fluxo é sempre o mesmo:
 * grava PENDING, avisa o app via WebSocket e dispara a IA em background.
 *
 * @param {object} params
 * @param {number} params.familyId
 * @param {number} params.memberId
 * @param {Buffer} params.fileBuffer - conteúdo do arquivo, sempre necessário (é o que vai pra IA)
 * @param {string} params.mimeType
 * @param {string} params.fileName
 * @param {string} [params.relativeFilePath] - presente quando o arquivo já foi salvo em disco
 *   (ex: 'uploads/123.jpg'); se ausente, o conteúdo é persistido em base64 no próprio banco.
 * @returns {Promise<number>} documentId criado
 */
async function createAndProcessDocument({ familyId, memberId, fileBuffer, mimeType, fileName, relativeFilePath }) {
    const fileType = mimeType.includes('pdf') ? 'pdf' : (mimeType.includes('image') ? 'image' : 'unknown');
    const isDiskFile = !!relativeFilePath;

    const insertDocQuery = isDiskFile
        ? `INSERT INTO inbox_documents (family_id, member_id, file_path, file_name, file_type, status)
           VALUES (?, ?, ?, ?, ?, 'PENDING')`
        : `INSERT INTO inbox_documents (family_id, member_id, file_path, file_name, file_type, file_base64, status)
           VALUES (?, ?, 'db_base64', ?, ?, ?, 'PENDING')`;

    const params = isDiskFile
        ? [familyId, memberId, relativeFilePath, fileName, fileType]
        : [familyId, memberId, fileName, fileType, fileBuffer.toString('base64')];

    // 1. Salvar no banco como PENDING
    const result = await runQuery(insertDocQuery, params);
    const documentId = result.lastID;

    // 2. Avisar o app de que um novo documento chegou (some da lista o "vazio" e já entra como PENDING)
    const { getIo } = require('../websockets/socket');
    const io = getIo();
    if (io) {
        io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'created' });
    }

    // 3. Chamar processamento em background (solto — não bloqueia a resposta HTTP)
    processDocumentAsync(documentId, familyId, memberId, fileBuffer, mimeType).catch(err => {
        console.error('[Background AI] Erro fatal no processDocumentAsync:', err);
    });

    return documentId;
}

exports.createAndProcessDocument = createAndProcessDocument;

exports.processUpload = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const familyId = req.user.family_id;
    const memberId = req.user.id;

    try {
        const documentId = await createAndProcessDocument({
            familyId,
            memberId,
            fileBuffer: req.file.buffer,
            mimeType: req.file.mimetype,
            fileName: req.file.originalname || 'comprovante.jpg',
        });

        res.status(200).json({
            message: 'Comprovante recebido! Processando com IA em segundo plano...',
            documentId
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
        // Só contas visíveis pra quem enviou o comprovante: a dele ou compartilhada.
        // card_last_digits vai junto pro geminiService poder casar a conta pelos 4
        // últimos dígitos do cartão em vez de só pelo nome do banco (ver ali o
        // porquê — nome de banco no comprovante variar demais era a causa mais
        // comum de duplicar conta).
        const accounts = await getQuery('SELECT id, name, card_last_digits FROM accounts WHERE family_id = ? AND (member_id IS NULL OR member_id = ?)', [familyId, memberId]);

        // Enviar para a IA
        const aiResult = await extractReceiptWithAI(fileBuffer, mimeType, categories, accounts);

        if (!aiResult) {
            console.error(`[Background AI] Falha ao ler documento #${documentId}`);
            await runQuery('UPDATE inbox_documents SET status = "FAILED" WHERE id = ?', [documentId]);
            return;
        }

        let accountId = aiResult.accountId;

        if (aiResult.shouldCreateAccount && aiResult.newAccountName) {
            // 'CHECKING' não existe no seletor de Tipo de Conta do app (só PERSONAL,
            // INVESTMENT, CREDIT) — uma conta criada com esse valor caía com o
            // dropdown "Tipo de Conta" sem nenhuma opção selecionada na tela de
            // editar. Grava também os 4 últimos dígitos identificados no
            // comprovante (se a IA leu algum) pra já existir cadastro suficiente
            // pra próximos comprovantes desse mesmo cartão baterem de primeira.
            const digits = aiResult.cardLastDigits
                ? String(aiResult.cardLastDigits).replace(/\D/g, '').slice(-4) || null
                : null;
            const insertAccount = await runQuery(
                'INSERT INTO accounts (family_id, name, current_balance, type, card_last_digits, is_debit, is_credit) VALUES (?, ?, 0, ?, ?, 1, 0)',
                [familyId, aiResult.newAccountName, 'PERSONAL', digits]
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

        // Memória do recebedor: se já vimos esse nome antes, a categoria que a
        // família usou historicamente pra ele é mais confiável que um palpite a
        // frio da IA — sobrescreve categoryId direto, sem precisar de confirmação
        // (baixo risco, é só categorização). Já a sugestão de conta a pagar
        // (suggestedRecurringBillId) sempre depende de confirmação manual do
        // usuário na Caixa de Entrada — nunca vincula sozinha.
        const payeeKey = normalizePayeeKey(description);
        let payeeMemory = null;
        let suggestedRecurringBillId = null;
        if (payeeKey) {
            const memoryRows = await getQuery(
                `SELECT * FROM payee_memory WHERE family_id = ? AND member_id = ? AND payee_key = ?`,
                [familyId, memberId, payeeKey]
            );
            payeeMemory = memoryRows[0] || null;

            if (payeeMemory && payeeMemory.last_category_id) {
                categoryId = payeeMemory.last_category_id;
            }

            if (payeeMemory && payeeMemory.recurring_bill_id) {
                suggestedRecurringBillId = payeeMemory.recurring_bill_id;
            } else {
                // Primeira vez que vemos esse recebedor — busca nas transações já
                // vinculadas manualmente antes dessa feature existir.
                suggestedRecurringBillId = await findHistoricalBillMatch(familyId, memberId, payeeKey).catch(() => null);
            }
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
                            'UPDATE inbox_documents SET status = "PROCESSED", extracted_data = ?, transaction_id = ?, payee_key = ?, suggested_recurring_bill_id = ?, suggestion_status = ? WHERE id = ?',
                            [
                                JSON.stringify(aiResult),
                                transactionCreatedId,
                                payeeKey || null,
                                suggestedRecurringBillId,
                                suggestedRecurringBillId ? 'PENDING' : null,
                                documentId
                            ]
                        ).catch(err => console.error('Erro update doc:', err));

                        await upsertPayeeMemory({
                            familyId,
                            memberId,
                            payeeKey,
                            payeeDisplayName: description,
                            categoryId,
                            accountId,
                            amount,
                            recurringBillId: suggestedRecurringBillId
                        }).catch(err => console.error('Erro ao gravar payee_memory:', err));
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
