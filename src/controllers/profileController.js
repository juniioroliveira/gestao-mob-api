const db = require('../config/database');
const { getIo } = require('../websockets/socket');

exports.getProfile = (req, res) => {
    const userId = req.user.id;

    const query = `
        SELECT m.id, m.name, m.email, m.role, m.is_admin, m.avatar_url, m.monthly_income,
               m.salary_day, m.advance_value, m.advance_day,
               f.name as family_name,
               m.pref_budget_alerts, m.pref_bill_reminders, m.pref_ai_processing,
               m.pref_weekly_summary, m.pref_use_biometrics, m.pref_hide_balances
        FROM members m
        JOIN families f ON m.family_id = f.id
        WHERE m.id = ?
    `;

    db.get(query, [userId], (err, row) => {
        if (err || !row) {
            console.error('Erro ao buscar perfil:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        res.json({
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            isAdmin: Boolean(row.is_admin),
            avatarUrl: row.avatar_url,
            familyName: row.family_name,
            monthlyIncome: row.monthly_income,
            salaryDay: row.salary_day,
            advanceValue: row.advance_value,
            advanceDay: row.advance_day,
            preferences: {
                budgetAlerts: Boolean(row.pref_budget_alerts),
                billReminders: Boolean(row.pref_bill_reminders),
                aiProcessing: Boolean(row.pref_ai_processing),
                weeklySummary: Boolean(row.pref_weekly_summary),
                useBiometrics: Boolean(row.pref_use_biometrics),
                hideBalances: Boolean(row.pref_hide_balances)
            }
        });
    });
};

exports.updatePreferences = (req, res) => {
    const userId = req.user.id;
    const { budgetAlerts, billReminders, aiProcessing, weeklySummary, useBiometrics, hideBalances } = req.body;

    const query = `
        UPDATE members SET 
            pref_budget_alerts = ?,
            pref_bill_reminders = ?,
            pref_ai_processing = ?,
            pref_weekly_summary = ?,
            pref_use_biometrics = ?,
            pref_hide_balances = ?
        WHERE id = ?
    `;

    db.run(query, [
        budgetAlerts ? 1 : 0,
        billReminders ? 1 : 0,
        aiProcessing ? 1 : 0,
        weeklySummary ? 1 : 0,
        useBiometrics ? 1 : 0,
        hideBalances ? 1 : 0,
        userId
    ], function(err) {
        if (err) {
            console.error('Erro ao atualizar preferências:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }
        res.json({ message: 'Preferências atualizadas com sucesso!' });
    });
};

exports.updateProfile = (req, res) => {
    const userId = req.user.id;
    const familyId = req.user.family_id;
    const { name, email, role, monthlyIncome, salaryDay, advanceValue, advanceDay } = req.body;

    const query = `
        UPDATE members SET 
            name = ?,
            email = ?,
            role = ?,
            monthly_income = ?,
            salary_day = ?,
            advance_value = ?,
            advance_day = ?
        WHERE id = ?
    `;

    db.run(query, [
        name, 
        email, 
        role, 
        monthlyIncome, 
        salaryDay || 5, 
        advanceValue || 0, 
        advanceDay || 20, 
        userId
    ], function(err) {
        if (err) {
            console.error('Erro ao atualizar perfil:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        getIo().to(`family_${familyId}`).emit('data_updated', { source: 'profile', action: 'updated' });

        res.json({ message: 'Perfil atualizado com sucesso!' });
    });
};

exports.updateFamily = (req, res) => {
    const familyId = req.user.family_id;
    const { familyName } = req.body;

    if (!familyName) {
        return res.status(400).json({ error: 'Nome da família é obrigatório.' });
    }

    const query = `UPDATE families SET name = ? WHERE id = ?`;

    db.run(query, [familyName, familyId], function(err) {
        if (err) {
            console.error('Erro ao atualizar família:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        getIo().to(`family_${familyId}`).emit('data_updated', { source: 'family', action: 'updated' });

        res.json({ message: 'Família atualizada com sucesso!' });
    });
};

exports.updateAvatar = (req, res) => {
    const userId = req.user.id;
    const familyId = req.user.family_id;
    const { avatarBase64 } = req.body;

    if (!avatarBase64) {
        return res.status(400).json({ error: 'Imagem não fornecida.' });
    }

    const query = `UPDATE members SET avatar_url = ? WHERE id = ?`;

    db.run(query, [avatarBase64, userId], function(err) {
        if (err) {
            console.error('Erro ao atualizar avatar:', err);
            return res.status(500).json({ error: 'Erro interno no servidor' });
        }

        getIo().to(`family_${familyId}`).emit('data_updated', { source: 'profile', action: 'updated' });

        res.json({ message: 'Avatar atualizado com sucesso!' });
    });
};
