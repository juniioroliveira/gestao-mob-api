const db = require('../config/database');

// Memória de "quem recebe o quê" — guarda por família E por membro (nunca
// família inteira, mesmo critério usado em todo o resto hoje) o último padrão
// de categoria/conta/valor de cada recebedor, e — quando o usuário confirma —
// a qual conta a pagar (recurring_bill) aquele recebedor pertence. Serve pra
// IA: (1) puxar a categoria certa direto do histórico em vez de adivinhar de
// novo toda vez, e (2) sugerir "essa transação pode ser da conta X" na Caixa
// de Entrada.
async function runMigration() {
    console.log('Starting migration: add_payee_memory');

    const statements = [
        `CREATE TABLE IF NOT EXISTS payee_memory (
            id INT AUTO_INCREMENT PRIMARY KEY,
            family_id INT NOT NULL,
            member_id INT NOT NULL,
            payee_key VARCHAR(255) NOT NULL,
            payee_display_name VARCHAR(255) NOT NULL,
            last_category_id INT NULL,
            last_account_id INT NULL,
            last_amount DECIMAL(10,2) NULL,
            recurring_bill_id INT NULL,
            occurrences INT DEFAULT 1,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_family_member_payee (family_id, member_id, payee_key)
        );`,
        // Guarda a sugestão de conta a pagar direto no documento — vira o item
        // "Ver / Confirmar / Recusar" na Caixa de Entrada.
        "ALTER TABLE inbox_documents ADD COLUMN payee_key VARCHAR(255) NULL;",
        "ALTER TABLE inbox_documents ADD COLUMN suggested_recurring_bill_id INT NULL;",
        "ALTER TABLE inbox_documents ADD COLUMN suggestion_status VARCHAR(20) NULL;", // PENDING | CONFIRMED | DISMISSED
    ];

    for (const sql of statements) {
        await new Promise((resolve) => {
            db.run(sql, [], function (err) {
                if (err) {
                    console.error(`Error executing: ${sql}`, err.message);
                } else {
                    console.log(`Success: ${sql}`);
                }
                resolve();
            });
        });
    }

    console.log('Migration finished.');
}

if (require.main === module) {
    runMigration().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runMigration };
