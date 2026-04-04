const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('🌱 Iniciando o seed do banco de dados SQLite...');

// Gerando um hash real para a senha '123456'
const defaultPasswordHash = bcrypt.hashSync('123456', 10);

db.serialize(() => {
    // 1. Limpar todas as tabelas e resetar os IDs
    const tables = [
        'transactions', 'recurring_bills', 'category_budgets',
        'categories', 'accounts', 'members', 'families'
    ];

    tables.forEach(table => {
        db.run(`DELETE FROM ${table}`);
    });
    db.run(`DELETE FROM sqlite_sequence`); // Reseta os AUTOINCREMENTs

    console.log('🧹 Tabelas limpas.');

    // 2. Inserir Família
    db.run(`INSERT INTO families (id, name) VALUES (1, 'Família Oliveira')`);

    // 3. Inserir Membros
    const stmtMembers = db.prepare(`INSERT INTO members (id, family_id, name, email, password_hash, role, is_admin, avatar_url, monthly_income) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmtMembers.run(1, 1, 'João Oliveira', 'joao.oliveira@email.com', defaultPasswordHash, 'Pai', 1, 'https://i.pravatar.cc/150?img=33', 5000.00);
    stmtMembers.run(2, 1, 'Maria Oliveira', 'maria.oliveira@email.com', defaultPasswordHash, 'Mãe', 1, 'https://i.pravatar.cc/150?img=47', 3500.00);
    stmtMembers.run(3, 1, 'Lucas Oliveira', 'lucas.oliveira@email.com', defaultPasswordHash, 'Filho', 0, 'https://i.pravatar.cc/150?img=59', 0.00);
    stmtMembers.finalize();

    // 4. Inserir Contas (Wallets)
    const stmtAccounts = db.prepare(`INSERT INTO accounts (id, family_id, member_id, name, type, current_balance) VALUES (?, ?, ?, ?, ?, ?)`);
    stmtAccounts.run(1, 1, null, 'Conta da Casa', 'SHARED', 1500.00);
    stmtAccounts.run(2, 1, null, 'Reserva de Emergência', 'INVESTMENT', 5200.00);
    stmtAccounts.run(3, 1, 1, 'Conta do João', 'PERSONAL', 4250.00);
    stmtAccounts.run(4, 1, 2, 'Conta da Maria', 'PERSONAL', 3800.50);
    stmtAccounts.finalize();

    // 5. Inserir Categorias
    const stmtCategories = db.prepare(`INSERT INTO categories (id, family_id, name, icon, color_hex, type) VALUES (?, ?, ?, ?, ?, ?)`);
    stmtCategories.run(1, 1, 'Contas Fixas (Casa)', 'home_rounded', '#4C9EEB', 'EXPENSE');
    stmtCategories.run(2, 1, 'Alimentação & Lazer', 'restaurant', '#FFA500', 'EXPENSE');
    stmtCategories.run(3, 1, 'Transporte', 'directions_car', '#800080', 'EXPENSE');
    stmtCategories.run(4, 1, 'Compras Extras', 'shopping_bag', '#E55A73', 'EXPENSE');
    stmtCategories.run(5, 1, 'Salário/Renda', 'attach_money', '#20D864', 'INCOME');
    stmtCategories.finalize();

    // 6. Inserir Orçamentos (Budgets)
    const stmtBudgets = db.prepare(`INSERT INTO category_budgets (id, category_id, month, year, budget_limit) VALUES (?, ?, ?, ?, ?)`);
    stmtBudgets.run(1, 1, 12, 2023, 1500.00);
    stmtBudgets.run(2, 2, 12, 2023, 500.00);
    stmtBudgets.run(3, 3, 12, 2023, 400.00);
    stmtBudgets.run(4, 4, 12, 2023, 200.00);
    stmtBudgets.finalize();

    // 7. Inserir Contas Fixas (Recurring Bills)
    const stmtBills = db.prepare(`INSERT INTO recurring_bills (id, family_id, member_id, category_id, name, amount, due_day, is_auto_pay) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    stmtBills.run(1, 1, null, 1, 'Aluguel', 1200.00, 10, 1);
    stmtBills.run(2, 1, null, 1, 'Conta de Luz', null, 15, 0);
    stmtBills.run(3, 1, null, 1, 'Internet', 150.00, 20, 1);
    stmtBills.run(4, 1, 2, 4, 'Manicure', 80.00, 5, 1);
    stmtBills.finalize();

    // 8. Inserir Transações
    const stmtTransactions = db.prepare(`INSERT INTO transactions (id, account_id, member_id, category_id, recurring_bill_id, amount, type, description, transaction_date, is_ai_processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmtTransactions.run(1, 1, 1, 1, null, 150.00, 'EXPENSE', 'Supermercado (Semanal)', '2023-12-16', 1);
    stmtTransactions.run(2, 1, 2, 1, 2, 85.50, 'EXPENSE', 'Conta de Luz (Novembro)', '2023-12-15', 0);
    stmtTransactions.run(3, 3, 1, 5, null, 4250.00, 'INCOME', 'Salário João', '2023-12-05', 0);
    stmtTransactions.run(4, 4, 2, 2, null, 120.00, 'EXPENSE', 'Jantar Fora', '2023-12-10', 0);
    stmtTransactions.run(5, 4, 2, 4, null, 250.00, 'EXPENSE', 'Roupas (Estourou limite)', '2023-12-12', 0);
    stmtTransactions.finalize();

    console.log('✅ Banco de dados populado com sucesso (Família Oliveira)!');
});

db.close();