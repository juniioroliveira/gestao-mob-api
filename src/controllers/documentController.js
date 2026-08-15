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

exports.getInboxDocuments = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT id, file_path, file_name, file_type, status, created_at, extracted_data
        FROM inbox_documents
        WHERE family_id = ?
        ORDER BY created_at DESC
    `;

    db.all(query, [familyId], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar documentos da inbox:', err);
            return res.status(500).json({ error: 'Erro interno' });
        }

        res.json({ documents: rows || [] });
    });
};

exports.deleteDocument = (req, res) => {
    const familyId = req.user.family_id;
    const documentId = req.params.id;

    // First get the file path
    db.get(`SELECT file_path FROM inbox_documents WHERE id = ? AND family_id = ?`, [documentId, familyId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Documento não encontrado' });
        }

        // Delete from disk
        const fullPath = path.join(__dirname, '../../', row.file_path);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }

        // Delete from DB
        db.run(`DELETE FROM inbox_documents WHERE id = ? AND family_id = ?`, [documentId, familyId], (err) => {
            if (err) return res.status(500).json({ error: 'Erro ao deletar documento' });
            res.json({ message: 'Documento excluído com sucesso' });
        });
    });
};

exports.cancelDocument = (req, res) => {
    const familyId = req.user.family_id;
    const documentId = req.params.id;

    db.run(
        `UPDATE inbox_documents SET status = "CANCELED", error_message = NULL WHERE id = ? AND family_id = ?`, 
        [documentId, familyId], 
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

    db.get(`SELECT * FROM inbox_documents WHERE id = ? AND family_id = ?`, [documentId, familyId], (err, row) => {
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
