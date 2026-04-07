const db = require('../config/database');

exports.getFixedExpenses = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT rb.id, rb.name, rb.amount, rb.due_day, rb.is_auto_pay, rb.is_active, rb.category_id, rb.member_id,
               c.name as category_name, c.color_hex as category_color,
               m.name as member_name, m.avatar_url as member_avatar
        FROM recurring_bills rb
        JOIN categories c ON rb.category_id = c.id
        LEFT JOIN members m ON rb.member_id = m.id
        WHERE rb.family_id = ?
        ORDER BY rb.due_day ASC
    `;

    db.all(query, [familyId], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar contas fixas:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        const expenses = rows.map(row => ({
            id: row.id,
            title: row.name,
            amount: row.amount || 0.00,
            rawAmount: row.amount,
            dueDate: `Dia ${row.due_day}`,
            dueDay: row.due_day,
            isAutoPay: Boolean(row.is_auto_pay),
            isActive: Boolean(row.is_active),
            categoryId: row.category_id,
            categoryName: row.category_name,
            categoryColor: row.category_color,
            memberId: row.member_id,
            ownerName: row.member_name || 'Casa',
            ownerAvatar: row.member_avatar || null
        }));

        res.json({ expenses });
    });
};

exports.createFixedExpense = (req, res) => {
    const familyId = req.user.family_id;
    const { name, amount, dueDay, isAutoPay, categoryId, memberId } = req.body;

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const query = `
        INSERT INTO recurring_bills (family_id, member_id, category_id, name, amount, due_day, is_auto_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        familyId,
        memberId || null,
        categoryId,
        name,
        amount || null,
        dueDay,
        isAutoPay ? 1 : 0
    ];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Erro ao criar conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao criar conta fixa' });
        }
        res.status(201).json({ message: 'Conta fixa criada com sucesso', id: this.lastID });
    });
};

exports.updateFixedExpense = (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;
    const { name, amount, dueDay, isAutoPay, isActive, categoryId, memberId } = req.body;

    if (!name || !dueDay || !categoryId) {
        return res.status(400).json({ error: 'Nome, dia de vencimento e categoria são obrigatórios' });
    }

    const query = `
        UPDATE recurring_bills 
        SET name = ?, amount = ?, due_day = ?, is_auto_pay = ?, is_active = ?, category_id = ?, member_id = ?
        WHERE id = ? AND family_id = ?
    `;
    const params = [
        name,
        amount || null,
        dueDay,
        isAutoPay ? 1 : 0,
        isActive !== undefined ? (isActive ? 1 : 0) : 1,
        categoryId,
        memberId || null,
        expenseId,
        familyId
    ];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Erro ao atualizar conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao atualizar conta fixa' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Conta fixa não encontrada' });
        }
        res.json({ message: 'Conta fixa atualizada com sucesso' });
    });
};

exports.deleteFixedExpense = (req, res) => {
    const familyId = req.user.family_id;
    const expenseId = req.params.id;

    const query = `DELETE FROM recurring_bills WHERE id = ? AND family_id = ?`;
    
    db.run(query, [expenseId, familyId], function(err) {
        if (err) {
            console.error('Erro ao excluir conta fixa:', err);
            return res.status(500).json({ error: 'Erro ao excluir conta fixa' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Conta fixa não encontrada' });
        }
        res.json({ message: 'Conta fixa excluída com sucesso' });
    });
};
