const db = require('../config/database');

exports.getFixedExpenses = (req, res) => {
    const familyId = req.user.family_id;

    const query = `
        SELECT rb.id, rb.name, rb.amount, rb.due_day, rb.is_auto_pay, rb.is_active,
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
            amount: row.amount || 0.00, // Se for null, exibimos 0 ou variável
            dueDate: `Dia ${row.due_day}`,
            isAutoPay: Boolean(row.is_auto_pay),
            isActive: Boolean(row.is_active),
            categoryName: row.category_name,
            categoryColor: row.category_color,
            ownerName: row.member_name || 'Casa',
            ownerAvatar: row.member_avatar || null
        }));

        res.json({ expenses });
    });
};
