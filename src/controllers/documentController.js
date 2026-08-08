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
        SELECT id, file_path, file_name, file_type, status, created_at
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
