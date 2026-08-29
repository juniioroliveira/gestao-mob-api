const db = require('../config/database');

// Marca se uma transação de receita É o salário (ou adiantamento) da pessoa,
// diferente de qualquer outra entrada de dinheiro (freela, presente, reembolso).
// Existe pra alimentar a Visão Mensal: meses passados/atuais usam a transação
// real marcada; meses futuros, sem transação nenhuma ainda, projetam a partir
// do que está configurado no perfil (monthly_income/salary_day/advance_day) —
// mas só enquanto não existir uma transação real marcada pra aquele mês, senão
// contaria a mesma renda duas vezes.
async function runMigration() {
    console.log('Starting migration: add_transaction_is_salary');

    const statements = [
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_salary TINYINT(1) NOT NULL DEFAULT 0;`,
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
