const db = require('../config/database');

// Caixa de entrada e notificações viram uma coisa só, com badge de não lidos —
// pra isso precisamos saber quando cada documento foi visto por quem o
// recebeu. NULL = ainda não lido; preenchido = timestamp de quando o dono
// abriu a tela e viu a lista.
async function runMigration() {
    console.log('Starting migration: add_read_at_to_inbox_documents');

    const statements = [
        "ALTER TABLE inbox_documents ADD COLUMN read_at TIMESTAMP NULL DEFAULT NULL;",
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
