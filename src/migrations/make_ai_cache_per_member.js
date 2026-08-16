const db = require('../config/database');

// Termômetro Financeiro passa a ser por membro de verdade — antes a cache de IA
// (family_ai_cache) era uma linha só por família, então dois membros com dias de
// salário/adiantamento diferentes disputavam a mesma resposta cacheada (quem
// abrisse por último "vencia" e sobrescrevia o que o outro via). Chave primária
// vira (family_id, member_id).
async function runMigration() {
    console.log('Starting migration: make_ai_cache_per_member');

    const statements = [
        // É só cache — sem problema nenhum limpar e deixar recalcular na próxima
        // abertura de cada membro.
        "DELETE FROM family_ai_cache;",
        "ALTER TABLE family_ai_cache DROP PRIMARY KEY;",
        "ALTER TABLE family_ai_cache ADD COLUMN member_id INT NOT NULL DEFAULT 0 AFTER family_id;",
        "ALTER TABLE family_ai_cache ADD PRIMARY KEY (family_id, member_id);",
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
