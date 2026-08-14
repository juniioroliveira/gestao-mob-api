const db = require('../config/database');
const fs = require('fs');
const path = require('path');

exports.uploadDocument = (req, res) => {
    const familyId = req.user.family_id;
    const memberId = req.user.id;
    
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo recebido' });
    }

    const { filename, path: filePath, mimetype } = req.file;
    let fileType = 'unknown';
    
    if (mimetype.includes('pdf')) fileType = 'pdf';
    else if (mimetype.includes('image')) fileType = 'image';

    const relativePath = `uploads/${filename}`;

    const query = `
        INSERT INTO inbox_documents (family_id, member_id, file_path, file_name, file_type, status)
        VALUES (?, ?, ?, ?, ?, 'PENDING')
    `;

    db.run(query, [familyId, memberId, relativePath, req.file.originalname, fileType], function(err) {
        if (err) {
            console.error('Erro ao salvar documento:', err);
            // Optionally delete the file if DB insert fails
            fs.unlinkSync(filePath);
            return res.status(500).json({ error: 'Erro ao salvar o registro no banco' });
        }
        
        res.status(201).json({ 
            message: 'Documento recebido com sucesso',
            document: {
                // Cannot use this.lastID easily across compatibility layers, we just return success
                fileName: req.file.originalname,
                status: 'PENDING'
            }
        });
    });
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

        if (row.file_path === 'db_base64' || !row.file_path.startsWith('uploads')) {
            return res.status(400).json({ error: 'Este documento é antigo e não suporta reprocessamento.' });
        }

        const fullPath = path.join(__dirname, '../../', row.file_path);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Arquivo da imagem não encontrado no disco.' });
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
                    const fileBuffer = fs.readFileSync(fullPath);
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
