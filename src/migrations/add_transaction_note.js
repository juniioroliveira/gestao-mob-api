const db = require('../config/database');

// Separa "de quem/pra quem" (transactions.description, o beneficiário — o único
// campo que existia até aqui) de "sobre o quê" (transactions.note — a mensagem
// do Pix, tipo "aluguel agosto", ou uma nota que a pessoa digita na mão). Nas
// telas de lançamentos, quando existe nota, ela vira o título em destaque e o
// beneficiário encolhe pra linha secundária — o nome de quem recebeu importa
// menos que o motivo do gasto quando os dois estão disponíveis.
async function runMigration() {
    console.log('Starting migration: add_transaction_note');

    const statements = [
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note VARCHAR(255) NULL;`,
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
