const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const { createAndProcessDocument } = require('./inboxController');

exports.uploadDocument = async (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;

    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo recebido' });
    }

    const { filename, path: filePath, mimetype, originalname } = req.file;
    const relativeFilePath = `uploads/${filename}`;

    try {
        // Multer salvou em disco (diskStorage) — lemos o buffer só pra alimentar a IA,
        // o arquivo em si já está persistido em uploads/.
        const fileBuffer = fs.readFileSync(filePath);

        // Mesma lógica de processamento usada pelo Atalho do iOS (inboxController):
        // grava PENDING, avisa o app via WebSocket e dispara a IA em background.
        const documentId = await createAndProcessDocument({
            familyId,
            memberId,
            fileBuffer,
            mimeType: mimetype,
            fileName: originalname,
            relativeFilePath,
        });

        res.status(201).json({
            message: 'Documento recebido com sucesso',
            document: {
                id: documentId,
                fileName: originalname,
                status: 'PENDING'
            }
        });
    } catch (err) {
        console.error('Erro ao salvar documento:', err);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(500).json({ error: 'Erro ao salvar o registro no banco' });
    }
};

// Resolve um content-type de verdade a partir do que foi guardado em file_type —
// esse campo já veio inconsistente ao longo do tempo (às vezes só "image", às
// vezes o mimetype completo tipo "image/png"), então cobre os dois formatos.
function resolveContentType(fileType) {
    if (!fileType) return 'application/octet-stream';
    const ft = fileType.toLowerCase();
    if (ft.includes('/')) return ft; // já é um mimetype completo
    if (ft === 'pdf') return 'application/pdf';
    if (ft === 'image') return 'image/jpeg'; // aposta razoável: maioria vem de câmera/print
    return 'application/octet-stream';
}

// Serve o arquivo em si (imagem/pdf) pra visualização no app — não existia
// nenhuma rota que devolvesse o conteúdo bruto até aqui, nem pros salvos em
// disco (uploads/) nem pros salvos em base64 direto no banco (fluxo do Atalho
// do iOS). Mesma checagem de dono das outras rotas da inbox.
exports.getDocumentFile = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.get(
        `SELECT file_path, file_type, file_base64 FROM inbox_documents WHERE id = ? AND family_id = ? AND member_id = ?`,
        [documentId, familyId, memberId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: 'Documento não encontrado' });
            }

            const contentType = resolveContentType(row.file_type);

            if (row.file_path === 'db_base64') {
                if (!row.file_base64) {
                    return res.status(404).json({ error: 'Conteúdo do arquivo não encontrado' });
                }
                const buffer = Buffer.from(row.file_base64, 'base64');
                res.set('Content-Type', contentType);
                return res.send(buffer);
            }

            const fullPath = path.join(__dirname, '../../', row.file_path);
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: 'Arquivo não encontrado no disco' });
            }
            res.set('Content-Type', contentType);
            return res.sendFile(fullPath);
        }
    );
};

exports.getInboxDocuments = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;

    // Sempre por membro — cada comprovante é de quem enviou, ninguém mais vê (nem
    // admin), mesmo critério já aplicado em contas/cartões. O LEFT JOIN traz o
    // nome da conta a pagar sugerida, quando tiver uma pendente de confirmação.
    const query = `
        SELECT d.id, d.file_path, d.file_name, d.file_type, d.status, d.created_at, d.extracted_data, d.read_at,
               d.suggested_recurring_bill_id, d.suggestion_status,
               rb.name as suggested_bill_name
        FROM inbox_documents d
        LEFT JOIN recurring_bills rb ON rb.id = d.suggested_recurring_bill_id
        WHERE d.family_id = ? AND d.member_id = ?
        ORDER BY d.created_at DESC
    `;

    db.all(query, [familyId, memberId], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar documentos da inbox:', err);
            return res.status(500).json({ error: 'Erro interno' });
        }

        res.json({ documents: rows || [] });
    });
};

// Badge do header (ícone único que substitui inbox + notificações) — conta
// quantos documentos desse membro específico ainda não foram vistos.
exports.getUnreadCount = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;

    db.get(
        `SELECT COUNT(*) as count FROM inbox_documents WHERE family_id = ? AND member_id = ? AND read_at IS NULL`,
        [familyId, memberId],
        (err, row) => {
            if (err) {
                console.error('Erro ao contar não lidos da inbox:', err);
                return res.status(500).json({ error: 'Erro interno' });
            }
            res.json({ count: row ? row.count : 0 });
        }
    );
};

// Chamado quando o dono efetivamente abre a Caixa de Entrada — zera o badge dele.
exports.markInboxRead = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;

    db.run(
        `UPDATE inbox_documents SET read_at = NOW() WHERE family_id = ? AND member_id = ? AND read_at IS NULL`,
        [familyId, memberId],
        function (err) {
            if (err) {
                console.error('Erro ao marcar inbox como lida:', err);
                return res.status(500).json({ error: 'Erro interno' });
            }

            if (this.changes > 0) {
                const { getIo } = require('../websockets/socket');
                const io = getIo();
                if (io) {
                    // 'documents' já é o source que o header escuta pra reconsultar o badge.
                    io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'read' });
                }
            }

            res.json({ message: 'Inbox marcada como lida', changed: this.changes });
        }
    );
};

// Marca só ESSE documento como lido (ex: ao abrir pra visualizar) — diferente
// do mark-read em massa acima, que marca tudo de uma vez só quando faz sentido
// (ex: um botão explícito "marcar tudo como lido").
exports.markDocumentRead = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.run(
        `UPDATE inbox_documents SET read_at = NOW() WHERE id = ? AND family_id = ? AND member_id = ? AND read_at IS NULL`,
        [documentId, familyId, memberId],
        function (err) {
            if (err) {
                console.error('Erro ao marcar documento como lido:', err);
                return res.status(500).json({ error: 'Erro interno' });
            }

            if (this.changes > 0) {
                const { getIo } = require('../websockets/socket');
                const io = getIo();
                if (io) {
                    io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'read' });
                }
            }

            res.json({ message: 'Documento marcado como lido', changed: this.changes });
        }
    );
};

exports.deleteDocument = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    // Só o dono do comprovante pode mexer nele — mesmo critério de visibilidade
    // aplicado na listagem.
    db.get(`SELECT file_path FROM inbox_documents WHERE id = ? AND family_id = ? AND member_id = ?`, [documentId, familyId, memberId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Documento não encontrado' });
        }

        // Delete from disk
        const fullPath = path.join(__dirname, '../../', row.file_path);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }

        // Delete from DB
        db.run(`DELETE FROM inbox_documents WHERE id = ? AND family_id = ? AND member_id = ?`, [documentId, familyId, memberId], (err) => {
            if (err) return res.status(500).json({ error: 'Erro ao deletar documento' });
            res.json({ message: 'Documento excluído com sucesso' });
        });
    });
};

exports.cancelDocument = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.run(
        `UPDATE inbox_documents SET status = "CANCELED", error_message = NULL WHERE id = ? AND family_id = ? AND member_id = ?`,
        [documentId, familyId, memberId],
        (err) => {
            if (err) return res.status(500).json({ error: 'Erro ao cancelar documento' });
            
            const { getIo } = require('../websockets/socket');
            const io = getIo();
            if (io) {
                io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'updated' });
            }
            res.json({ message: 'Documento cancelado' });
        }
    );
};

exports.reprocessDocument = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.get(`SELECT * FROM inbox_documents WHERE id = ? AND family_id = ? AND member_id = ?`, [documentId, familyId, memberId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Documento não encontrado' });

        if (row.file_path !== 'db_base64' && !row.file_path.startsWith('uploads')) {
            return res.status(400).json({ error: 'Formato de arquivo não suportado para reprocessamento.' });
        }

        if (row.file_path !== 'db_base64') {
            const fullPath = path.join(__dirname, '../../', row.file_path);
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: 'Arquivo da imagem não encontrado no disco.' });
            }
        } else if (!row.file_base64) {
            return res.status(404).json({ error: 'Arquivo base64 não encontrado no banco.' });
        }

        db.run(
            `UPDATE inbox_documents SET status = "PENDING", error_message = NULL, extracted_data = NULL WHERE id = ?`, 
            [documentId], 
            (err) => {
                if (err) return res.status(500).json({ error: 'Erro ao atualizar status' });
                
                const { getIo } = require('../websockets/socket');
                const io = getIo();
                if (io) {
                    io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'updated' });
                }
                
                res.json({ message: 'Reprocessamento iniciado' });

                // Inicia em background
                try {
                    let fileBuffer;
                    if (row.file_path === 'db_base64') {
                        fileBuffer = Buffer.from(row.file_base64, 'base64');
                    } else {
                        const fullPath = path.join(__dirname, '../../', row.file_path);
                        fileBuffer = fs.readFileSync(fullPath);
                    }
                    const mimeType = row.file_type === 'pdf' ? 'application/pdf' : 'image/png';
                    const { processDocumentAsync } = require('./inboxController');
                    processDocumentAsync(documentId, familyId, memberId, fileBuffer, mimeType).catch(() => {});
                } catch (e) {
                    console.error('Erro ao ler arquivo para reprocessamento:', e);
                }
            }
        );
    });
};

// "Confirmar" da sugestão "essa transação pode ser da conta X" — vincula de
// verdade a transação criada pela IA à conta fixa sugerida (mesmo efeito de
// usar "Vincular transação" na tela de Contas a Pagar, só que originado da
// Caixa de Entrada).
exports.confirmSuggestion = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.get(
        `SELECT transaction_id, suggested_recurring_bill_id, payee_key FROM inbox_documents
         WHERE id = ? AND family_id = ? AND member_id = ? AND suggestion_status = 'PENDING'`,
        [documentId, familyId, memberId],
        (err, row) => {
            if (err || !row || !row.suggested_recurring_bill_id || !row.transaction_id) {
                return res.status(404).json({ error: 'Sugestão não encontrada ou já resolvida' });
            }

            db.run(
                `UPDATE transactions SET recurring_bill_id = ? WHERE id = ?`,
                [row.suggested_recurring_bill_id, row.transaction_id],
                (errTx) => {
                    if (errTx) return res.status(500).json({ error: 'Erro ao vincular transação' });

                    db.run(
                        `UPDATE inbox_documents SET suggestion_status = 'CONFIRMED' WHERE id = ?`,
                        [documentId],
                        (errDoc) => {
                            if (errDoc) console.error('Erro ao marcar sugestão confirmada:', errDoc);

                            // Reforça a memória — próxima vez que esse recebedor aparecer,
                            // a sugestão já nasce a partir de uma confirmação real.
                            if (row.payee_key) {
                                db.run(
                                    `UPDATE payee_memory SET recurring_bill_id = ? WHERE family_id = ? AND member_id = ? AND payee_key = ?`,
                                    [row.suggested_recurring_bill_id, familyId, memberId, row.payee_key],
                                    () => {}
                                );
                            }

                            const { triggerUpdate } = require('../services/financialEventService');
                            const { getIo } = require('../websockets/socket');
                            const io = getIo();
                            if (io) {
                                io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'updated' });
                                io.to(`family_${familyId}`).emit('data_updated', { source: 'fixed_expenses', action: 'linked' });
                            }
                            triggerUpdate(familyId);

                            res.json({ message: 'Transação vinculada à conta a pagar com sucesso' });
                        }
                    );
                }
            );
        }
    );
};

// "Recusar" — a sugestão específica desse documento não vale, e a memória
// desse recebedor esquece esse vínculo (não insiste na mesma sugestão errada
// de novo), mas continua aprendendo categoria/valor normalmente. Além disso,
// grava a recusa em payee_bill_dismissals: sem isso, o findHistoricalBillMatch
// (usado quando não sobra memória) reconstruía a mesma sugestão do zero a
// partir do histórico de transações no próximo comprovante desse beneficiário.
exports.dismissSuggestion = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    const documentId = req.params.id;

    db.get(
        `SELECT payee_key, suggested_recurring_bill_id FROM inbox_documents WHERE id = ? AND family_id = ? AND member_id = ? AND suggestion_status = 'PENDING'`,
        [documentId, familyId, memberId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: 'Sugestão não encontrada ou já resolvida' });
            }

            db.run(
                `UPDATE inbox_documents SET suggestion_status = 'DISMISSED' WHERE id = ?`,
                [documentId],
                (errDoc) => {
                    if (errDoc) return res.status(500).json({ error: 'Erro ao recusar sugestão' });

                    if (row.payee_key) {
                        db.run(
                            `UPDATE payee_memory SET recurring_bill_id = NULL WHERE family_id = ? AND member_id = ? AND payee_key = ?`,
                            [familyId, memberId, row.payee_key],
                            () => {}
                        );
                    }

                    // findHistoricalBillMatch busca só pelo beneficiário puro (sem a
                    // mensagem do Pix, quando payee_key veio composto como
                    // "beneficiario::mensagem") — a exclusão precisa valer no mesmo nível.
                    if (row.payee_key && row.suggested_recurring_bill_id) {
                        const beneficiaryKey = row.payee_key.split('::')[0];
                        db.run(
                            `INSERT IGNORE INTO payee_bill_dismissals (family_id, member_id, payee_key, recurring_bill_id) VALUES (?, ?, ?, ?)`,
                            [familyId, memberId, beneficiaryKey, row.suggested_recurring_bill_id],
                            () => {}
                        );
                    }

                    const { getIo } = require('../websockets/socket');
                    const io = getIo();
                    if (io) {
                        io.to(`family_${familyId}`).emit('data_updated', { source: 'documents', action: 'updated' });
                    }

                    res.json({ message: 'Sugestão recusada' });
                }
            );
        }
    );
};

// Sugestão pendente mais recente do membro logado — alimenta o banner
// flutuante global (aparece em qualquer tela, não só na Caixa de Entrada).
// Só uma por vez de propósito: mostrar várias ao mesmo tempo competiria por
// atenção; a próxima aparece assim que essa for resolvida (Confirmar/Recusar)
// ou o app reconsultar depois de um evento de WebSocket.
exports.getPendingSuggestion = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;

    const query = `
        SELECT d.id, d.extracted_data, d.file_name, d.suggested_recurring_bill_id, rb.name as suggested_bill_name
        FROM inbox_documents d
        JOIN recurring_bills rb ON rb.id = d.suggested_recurring_bill_id
        WHERE d.family_id = ? AND d.member_id = ? AND d.suggestion_status = 'PENDING'
        ORDER BY d.created_at DESC
        LIMIT 1
    `;

    db.get(query, [familyId, memberId], (err, row) => {
        if (err) {
            console.error('Erro ao buscar sugestão pendente:', err);
            return res.status(500).json({ error: 'Erro interno' });
        }

        if (!row) {
            return res.json({ suggestion: null });
        }

        let description = null;
        let amount = null;
        try {
            const extracted = JSON.parse(row.extracted_data || '{}');
            description = extracted.description || null;
            amount = extracted.amount != null ? Number(extracted.amount) : null;
        } catch (_) {}

        res.json({
            suggestion: {
                documentId: row.id,
                fileName: row.file_name,
                description,
                amount,
                suggestedBillId: row.suggested_recurring_bill_id,
                suggestedBillName: row.suggested_bill_name,
            }
        });
    });
};
