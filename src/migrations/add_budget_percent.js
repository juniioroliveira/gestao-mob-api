const db = require('../config/database');

// Limite de categoria passa a ser guardado como PERCENTUAL (do salário de quem está
// vendo), não mais como um valor em R$ já calculado e travado no momento do save.
// budget_limit continua existindo (legado), mas deixa de ser a fonte de verdade —
// o R$ exibido agora é sempre recalculado na hora, a partir de budget_percent x a
// renda relevante no contexto (do membro, ou da família quando for visão agregada).
async function runMigration() {
    console.log('Starting migration: add_budget_percent');

    const statements = [
        "ALTER TABLE category_budgets ADD COLUMN budget_percent DECIMAL(5,2) DEFAULT NULL;",
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
