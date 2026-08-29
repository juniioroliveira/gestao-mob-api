const db = require('../config/database');

// Registro permanente de "esse beneficiário NÃO é dessa conta a pagar" — criado
// porque recusar uma sugestão só limpava payee_memory.recurring_bill_id, mas
// findHistoricalBillMatch (o fallback usado quando não há memória confirmada)
// reconstrói a sugestão do zero a partir do histórico de transações toda vez —
// sem isso, uma sugestão recusada podia voltar a ser sugerida de novo pro
// próximo comprovante do mesmo beneficiário.
async function runMigration() {
    console.log('Starting migration: add_payee_bill_dismissals');

    const statements = [
        `CREATE TABLE IF NOT EXISTS payee_bill_dismissals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            family_id INT NOT NULL,
            member_id INT NOT NULL,
            payee_key VARCHAR(255) NOT NULL,
            recurring_bill_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_family_member_payee_bill (family_id, member_id, payee_key, recurring_bill_id)
        );`,
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
