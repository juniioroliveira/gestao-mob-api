const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Erro ao conectar ao banco SQLite:', err.message);
    } else {
        console.log('✅ Conectado ao banco de dados SQLite.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // 1. Famílias
        db.run(`CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // 2. Membros
        db.run(`CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            avatar_url TEXT,
            monthly_income REAL DEFAULT 0.00,
            pref_budget_alerts INTEGER DEFAULT 1,
            pref_bill_reminders INTEGER DEFAULT 1,
            pref_ai_processing INTEGER DEFAULT 1,
            pref_weekly_summary INTEGER DEFAULT 0,
            pref_use_biometrics INTEGER DEFAULT 1,
            pref_hide_balances INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
        )`);

        // 3. Contas (Wallets)
        db.run(`CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            member_id INTEGER,
            name TEXT NOT NULL,
            type TEXT CHECK(type IN ('SHARED', 'PERSONAL', 'INVESTMENT')) NOT NULL,
            current_balance REAL DEFAULT 0.00,
            bank_code TEXT,
            color_hex TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
            FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
        )`);

        // Add columns to accounts table if they don't exist (Migration)
        db.run(`ALTER TABLE accounts ADD COLUMN bank_code TEXT;`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE accounts ADD COLUMN color_hex TEXT;`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE accounts ADD COLUMN card_last_digits TEXT;`, (err) => { /* ignore if exists */ });

        // 3.5 Bancos Reais
        db.run(`CREATE TABLE IF NOT EXISTS banks (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color_hex TEXT NOT NULL
        )`, () => {
            // Seed
            const banks = [
                ['260', 'Nubank', '#8A05BE'],
                ['341', 'Itaú', '#EC7000'],
                ['033', 'Santander', '#CC0000'],
                ['237', 'Bradesco', '#CC092F'],
                ['001', 'Banco do Brasil', '#F8D117'],
                ['104', 'Caixa Econômica', '#005CA9'],
                ['077', 'Inter', '#FF7A00'],
                ['336', 'C6 Bank', '#242424'],
                ['208', 'BTG Pactual', '#002A54'],
                ['748', 'Sicredi', '#00A559'],
                ['XP', 'XP Investimentos', '#000000'],
                ['MERCADO', 'Mercado Pago', '#009EE3'],
                ['PICPAY', 'PicPay', '#00C1EB'],
                ['000', 'Outros / Carteira', '#607D8B']
            ];
            
            const stmt = db.prepare("INSERT OR IGNORE INTO banks (code, name, color_hex) VALUES (?, ?, ?)");
            banks.forEach(b => stmt.run(b));
            stmt.finalize();
        });

        // 4. Categorias
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            icon TEXT,
            color_hex TEXT,
            type TEXT CHECK(type IN ('INCOME', 'EXPENSE')) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
        )`);

        // 5. Orçamentos Mensais (Budgets)
        db.run(`CREATE TABLE IF NOT EXISTS category_budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            budget_limit REAL NOT NULL,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
            UNIQUE (category_id, month, year)
        )`);

        // 6. Contas Fixas / Recorrentes
        db.run(`CREATE TABLE IF NOT EXISTS recurring_bills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            member_id INTEGER,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            amount REAL,
            due_day INTEGER NOT NULL,
            is_auto_pay INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
            FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
        )`);

        // 7. Transações
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            member_id INTEGER NOT NULL,
            category_id INTEGER,
            destination_account_id INTEGER,
            recurring_bill_id INTEGER,
            amount REAL NOT NULL,
            type TEXT CHECK(type IN ('INCOME', 'EXPENSE', 'TRANSFER')) NOT NULL,
            description TEXT NOT NULL,
            transaction_date DATE NOT NULL,
            attachment_url TEXT,
            is_ai_processed INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
            FOREIGN KEY (recurring_bill_id) REFERENCES recurring_bills(id) ON DELETE SET NULL,
            FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )`);
        
        console.log('✅ Tabelas SQLite sincronizadas com sucesso.');
    });
}

module.exports = db;